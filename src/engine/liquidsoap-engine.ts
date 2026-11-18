// SPDX-License-Identifier: AGPL-3.0-or-later
// LiquidsoapEngine (spec 001): the AudioEngine / AirEngine implementation talking to the
// real Liquidsoap over telnet. The audio never depends on it (ADR 0001): if this client is
// stuck or dead, the engine plays what is queued, then its fallback folder.
import type { Asset } from "../library/library.js";
import {
  type AirEngine, type EngineDetail, EngineError, type EngineSource, type NowPlaying, type QueueItem,
} from "./engine.js";
import { pathProblem, realTimers, safeForLog, TelnetLink, type TelnetOptions } from "./telnet.js";

export interface LiquidsoapEngineOptions extends Omit<TelnetOptions, "onConnected"> {
  /** Media root as seen by the control plane (default `/media`). */
  mediaRoot?: string;
  /** The same folder as seen by Liquidsoap (default: identical). */
  engineMediaRoot?: string;
  /** Library lookup, control-plane path to asset. May throw: treated as "not found". */
  resolve?: (path: string) => Asset | undefined;
  /** Responses are cached this long by `healthy()` (ms). */
  healthCacheMs?: number;
  healthTimeoutMs?: number;
  /** Max unknown requests resolved (one metadata command each) per queue read. */
  maxUnknownPerRead?: number;
}

interface LedgerEntry {
  asset: Asset;
}

interface RawQueueEntry {
  rid: number;
  /** Path as reported by the engine (untrusted), when we could read it. */
  enginePath: string | null;
}

const RID = /^\d{1,9}$/;

/** `a/b/` becomes `/a/b`; throws on anything unsafe: this is configuration, checked at start. */
function normalizeRoot(root: string, label: string): string {
  const problem = pathProblem(root);
  if (problem) throw new EngineError("invalid_input", `${label}: ${problem}`);
  const trimmed = root.replace(/\/+$/, "");
  return trimmed; // "" means the filesystem root
}

/** Seconds from Liquidsoap's `uptime` answer (`0d 00h 00m 09s`), or null if unreadable. */
export function parseUptime(lines: string[]): number | null {
  const m = /^(\d+)d (\d+)h (\d+)m (\d+)s$/.exec((lines[0] ?? "").trim());
  if (!m) return null;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  return ((d * 24 + h) * 60 + mi) * 60 + s;
}

/** `key=value` lines to a map; only the first occurrence of a key counts. */
function keyValues(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) {
    const i = l.indexOf("=");
    if (i <= 0) continue;
    const k = l.slice(0, i);
    if (!out.has(k)) out.set(k, l.slice(i + 1));
  }
  return out;
}

/** Liquidsoap prints metadata as `key="escaped value"`. Returns the unescaped values. */
function parseMetadata(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const l of lines) {
    const m = /^([A-Za-z0-9_.-]{1,64})="(.*)"$/.exec(l);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    if (!out.has(m[1])) out.set(m[1], m[2].replace(/\\(["\\])/g, "$1"));
  }
  return out;
}

function baseNameNoExt(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export class LiquidsoapEngine implements AirEngine {
  private readonly link: TelnetLink;
  private readonly now: () => number;
  private readonly mediaRoot: string;
  private readonly engineRoot: string;
  private readonly resolver: (path: string) => Asset | undefined;
  private readonly healthCacheMs: number;
  private readonly healthTimeoutMs: number;
  private readonly maxUnknown: number;
  private readonly timers: NonNullable<TelnetOptions["timers"]>;
  private readonly log: (level: "info" | "warn", message: string) => void;

  private ledger = new Map<number, LedgerEntry>();
  private queueRead: Promise<QueueItem[]> | undefined;
  private health: { at: number; ok: boolean } | undefined;
  private healthInflight: Promise<boolean> | undefined;
  private lastProbeUptime: number | null = null;
  private lastStateUptime: number | null = null;
  private seen: { rid: string; file: string; at: string } | undefined;

  constructor(o: LiquidsoapEngineOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? (() => undefined);
    this.mediaRoot = normalizeRoot(o.mediaRoot ?? "/media", "media root");
    this.engineRoot = normalizeRoot(o.engineMediaRoot ?? o.mediaRoot ?? "/media", "engine media root");
    this.resolver = o.resolve ?? (() => undefined);
    this.healthCacheMs = o.healthCacheMs ?? 2000;
    this.healthTimeoutMs = o.healthTimeoutMs ?? 2000;
    this.maxUnknown = o.maxUnknownPerRead ?? 50;
    this.link = new TelnetLink({
      ...o,
      log: this.log,
      onConnected: () => {
        // RIDs restart from zero with a new engine process: never trust them across connections.
        this.ledger.clear();
        this.lastProbeUptime = null;
        this.lastStateUptime = null;
      },
    });
    this.timers = o.timers ?? realTimers;
  }

  /** Connect in the background; never throws, never blocks (startup does not need the engine). */
  start(): void {
    this.link.start();
  }

  close(): Promise<void> {
    return this.link.close();
  }

  detail(): EngineDetail {
    const ok = this.link.lastOkAt;
    return {
      connected: this.link.connected,
      lastOkAt: ok === null ? null : new Date(ok).toISOString(),
      lastError: this.link.lastError,
    };
  }

  // ------------------------------------------------------------------ paths
  private toEngine(path: string): string {
    const problem = pathProblem(path);
    if (problem) throw new EngineError("invalid_input", `invalid path: ${problem}`);
    if (!path.startsWith(`${this.mediaRoot}/`)) throw new EngineError("invalid_input", "path is outside the media root");
    return `${this.engineRoot}${path.slice(this.mediaRoot.length)}`;
  }

  /** Engine path to control path; null when outside the mapped root or unsafe. */
  private toControl(enginePath: string): string | null {
    if (pathProblem(enginePath) !== null) return null;
    if (!enginePath.startsWith(`${this.engineRoot}/`)) return null;
    return `${this.mediaRoot}${enginePath.slice(this.engineRoot.length)}`;
  }

  private lookup(enginePath: string): Asset | undefined {
    const control = this.toControl(enginePath);
    if (control === null) return undefined;
    try {
      return this.resolver(control);
    } catch (e) {
      this.log("warn", `library lookup failed: ${safeForLog(String(e))}`);
      return undefined;
    }
  }

  // ------------------------------------------------------------------ AudioEngine
  async push(asset: Asset): Promise<void> {
    const enginePath = this.toEngine(asset.path); // throws invalid_input, nothing sent
    const lines = await this.link.send({ name: "push", path: enginePath });
    const first = lines[0];
    if (lines.length !== 1 || first === undefined || !RID.test(first)) {
      throw new EngineError("protocol", "unexpected answer to push", true);
    }
    this.ledger.set(Number(first), { asset });
  }

  async queuedSeconds(): Promise<number> {
    const items = await this.readQueue();
    let total = 0;
    let unknown = 0;
    for (const it of items) {
      if (it.durationS === null) unknown++;
      else total += it.durationS;
    }
    if (unknown > 0) this.log("warn", `${unknown} queued track(s) not in the library: counted as 0 s`);
    return total;
  }

  async queue(): Promise<QueueItem[]> {
    return this.readQueue();
  }

  async next(): Promise<NowPlaying | null> {
    const first = (await this.readQueue())[0];
    if (!first) return null;
    return {
      title: first.title ?? "", artist: first.artist ?? "", assetId: first.assetId,
      path: first.path ?? "", startedAt: null,
    };
  }

  async healthy(): Promise<boolean> {
    const cached = this.health;
    if (cached && this.now() - cached.at < this.healthCacheMs) return cached.ok;
    if (this.healthInflight) return this.healthInflight;
    const p = this.probe().finally(() => {
      this.healthInflight = undefined;
    });
    this.healthInflight = p;
    return p;
  }

  /** One `uptime` command, bounded by an own timer so the caller never waits past the limit. */
  private probe(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean): void => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        this.health = { at: this.now(), ok };
        resolve(ok);
      };
      const timer = this.timers.setTimeout(() => finish(false), this.healthTimeoutMs);
      this.link.send({ name: "uptime" }, { timeoutMs: this.healthTimeoutMs }).then(
        (lines) => {
          this.observeUptime("probe", parseUptime(lines));
          finish(true);
        },
        () => finish(false), // the link already noted the error code
      );
    });
  }

  private observeUptime(kind: "probe" | "state", seconds: number | null): void {
    if (seconds === null) return;
    const prev = kind === "probe" ? this.lastProbeUptime : this.lastStateUptime;
    if (kind === "probe") this.lastProbeUptime = seconds;
    else this.lastStateUptime = seconds;
    if (prev !== null && seconds < prev) {
      this.log("info", "engine restarted (uptime went back): request cache cleared");
      this.ledger.clear();
    }
  }

  // ------------------------------------------------------------------ queue
  private readQueue(): Promise<QueueItem[]> {
    if (!this.queueRead) {
      const p = this.doReadQueue().finally(() => {
        this.queueRead = undefined;
      });
      this.queueRead = p;
    }
    return this.queueRead;
  }

  private async doReadQueue(): Promise<QueueItem[]> {
    const lines = await this.link.send({ name: "queue" });
    const text = lines.join(" ").trim();
    const rids: number[] = [];
    if (text !== "") {
      for (const tok of text.split(/\s+/)) {
        if (!RID.test(tok)) throw new EngineError("protocol", "unexpected answer to the queue listing");
        rids.push(Number(tok));
      }
    }
    // Forget what is no longer waiting (played or removed): the ledger stays small.
    const waiting = new Set(rids);
    for (const k of this.ledger.keys()) if (!waiting.has(k)) this.ledger.delete(k);

    const items: QueueItem[] = [];
    let unknownLookups = 0;
    for (const rid of rids) {
      const known = this.ledger.get(rid);
      if (known) {
        items.push(this.itemOf(rid, known.asset, known.asset.path));
        continue;
      }
      if (unknownLookups >= this.maxUnknown) {
        items.push({ rid, title: null, artist: null, assetId: null, path: null, durationS: null });
        continue;
      }
      unknownLookups++;
      const raw = await this.readRequest(rid);
      const asset = raw.enginePath === null ? undefined : this.lookup(raw.enginePath);
      if (asset) {
        this.ledger.set(rid, { asset });
        items.push(this.itemOf(rid, asset, asset.path));
      } else {
        const control = raw.enginePath === null ? null : this.toControl(raw.enginePath);
        items.push({
          rid, title: raw.enginePath === null ? null : baseNameNoExt(raw.enginePath), artist: null,
          assetId: null, path: control ?? raw.enginePath, durationS: null,
        });
      }
    }
    return items;
  }

  private itemOf(rid: number, a: Asset, path: string): QueueItem {
    return { rid, title: a.title, artist: a.artist, assetId: a.id, path, durationS: a.durationS };
  }

  /** Read a request's initial URI. An answer that is not metadata means "unknown request". */
  private async readRequest(rid: number): Promise<RawQueueEntry> {
    const lines = await this.link.send({ name: "metadata", rid });
    const uri = parseMetadata(lines).get("initial_uri");
    return { rid, enginePath: uri !== undefined && pathProblem(uri) === null ? uri : null };
  }

  // ------------------------------------------------------------------ state
  async state(): Promise<{ source: EngineSource; current: NowPlaying | null }> {
    const kv = keyValues(await this.link.send({ name: "state" }));
    const raw = kv.get("source");
    const source: EngineSource = raw === "direct" || raw === "auto" || raw === "fallback" ? raw : "unknown";
    const up = kv.get("uptime");
    if (up !== undefined && /^\d{1,12}(\.\d{1,12})?$/.test(up)) this.observeUptime("state", Number(up));
    if (source === "unknown" || source === "direct") return { source, current: null };

    const file = kv.get("filename");
    const rid = kv.get("rid") ?? "";
    if (file === undefined || file === "" || pathProblem(file) !== null || (rid !== "" && !RID.test(rid))) {
      return { source, current: null };
    }
    const asset = this.lookup(file);
    const control = this.toControl(file);
    // First time this track is seen on air by this process (control clock, not the engine's).
    if (!this.seen || this.seen.rid !== rid || this.seen.file !== file) {
      this.seen = { rid, file, at: new Date(this.now()).toISOString() };
    }
    return {
      source,
      current: {
        title: asset?.title ?? baseNameNoExt(file), artist: asset?.artist ?? "",
        assetId: asset?.id ?? null, path: control ?? file, startedAt: this.seen.at,
      },
    };
  }

  async skip(): Promise<{ skipped: boolean }> {
    const { source } = await this.state();
    if (source !== "auto") return { skipped: false };
    const lines = await this.link.send({ name: "skip" });
    if (lines.some((l) => /^ERROR/i.test(l))) throw new EngineError("protocol", "skip refused by the engine", true);
    return { skipped: true };
  }
}
