// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Asset } from "../library/library.js";

/**
 * The audio plane, seen from the control plane (ADR 0001).
 * The real implementation drives Liquidsoap; the control plane must keep
 * working (and the engine keep playing) if the other side is down.
 *
 * Contract: `push` and `queuedSeconds` reject with an {@link EngineError} when the engine
 * cannot be reached (never a fake `0`); `healthy` never rejects.
 */
export interface AudioEngine {
  /** Append a track to the playout queue. */
  push(asset: Asset): Promise<void>;
  /** Seconds of audio already queued ahead of what is playing. */
  queuedSeconds(): Promise<number>;
  /** Is the engine reachable? ("answers to control", not "sound comes out": that is item 003.) */
  healthy(): Promise<boolean>;
}

export type EngineErrorCode = "unreachable" | "timeout" | "disconnected" | "protocol" | "invalid_input" | "busy";

/** Typed engine failure. `maybeApplied`: a write command may have run although no answer came. */
export class EngineError extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    readonly maybeApplied = false,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** Which source is on air. `stream` is reserved to item 009 and is not emitted yet. */
export type EngineSource = "auto" | "direct" | "stream" | "fallback" | "unknown";

export interface NowPlaying {
  title: string;
  artist: string;
  assetId: number | null;
  path: string;
  /** First time the control plane observed this track on air (control clock, ISO 8601 UTC). */
  startedAt: string | null;
}

export interface QueueItem {
  rid: number;
  title: string | null;
  artist: string | null;
  assetId: number | null;
  path: string | null;
  /** `null`: not in the library, counts as 0 s in `queuedSeconds`. */
  durationS: number | null;
}

export interface EngineDetail {
  connected: boolean;
  lastOkAt: string | null;
  lastError: EngineErrorCode | null;
}

/** What the control room needs on top of {@link AudioEngine}. */
export interface AirEngine extends AudioEngine {
  state(): Promise<{ source: EngineSource; current: NowPlaying | null }>;
  next(): Promise<NowPlaying | null>;
  queue(): Promise<QueueItem[]>;
  /** Skip the track in the queue; only acts when the source is `auto`. */
  skip(): Promise<{ skipped: boolean }>;
  /** Synchronous, cheap, never throws: connection facts for the health endpoint. */
  detail(): EngineDetail;
}

/** In-memory engine for tests and for developing without Docker. */
export class FakeEngine implements AirEngine {
  /** The pushed tracks, in order. */
  readonly pushed: Asset[] = [];
  up = true;
  source: EngineSource = "auto";
  /** What the fake plays when the queue is empty or a direct is on. */
  current: NowPlaying | null = null;

  private check(): void {
    if (!this.up) throw new EngineError("unreachable", "engine unreachable");
  }

  async push(asset: Asset): Promise<void> {
    this.check();
    this.pushed.push(asset);
  }
  async queuedSeconds(): Promise<number> {
    this.check();
    return this.pushed.reduce((s, a) => s + a.durationS, 0);
  }
  async healthy(): Promise<boolean> {
    return this.up;
  }
  async state(): Promise<{ source: EngineSource; current: NowPlaying | null }> {
    this.check();
    return { source: this.source, current: this.current };
  }
  async next(): Promise<NowPlaying | null> {
    this.check();
    const a = this.pushed[0];
    return a ? { title: a.title, artist: a.artist, assetId: a.id, path: a.path, startedAt: null } : null;
  }
  async queue(): Promise<QueueItem[]> {
    this.check();
    return this.pushed.map((a, i) => ({
      rid: i + 1, title: a.title, artist: a.artist, assetId: a.id, path: a.path, durationS: a.durationS,
    }));
  }
  async skip(): Promise<{ skipped: boolean }> {
    this.check();
    if (this.source !== "auto") return { skipped: false };
    const a = this.pushed.shift();
    this.current = a ? { title: a.title, artist: a.artist, assetId: a.id, path: a.path, startedAt: null } : null;
    return { skipped: true };
  }
  detail(): EngineDetail {
    return { connected: this.up, lastOkAt: null, lastError: this.up ? null : "unreachable" };
  }
}
