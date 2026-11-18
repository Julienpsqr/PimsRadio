// SPDX-License-Identifier: AGPL-3.0-or-later
// Test helpers only: a scriptable fake Liquidsoap telnet server (real sockets on 127.0.0.1,
// ephemeral port) and a manual clock/timer set. No sleeping anywhere: tests wait for
// observable events and move time explicitly.
import net from "node:net";
import type { Asset } from "../library/library.js";
import type { TimerApi } from "./telnet.js";

/** Let the event loop turn until the condition holds (bounded, not time-based). */
export async function until(cond: () => boolean, label = "condition", turns = 20_000): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`never became true: ${label}`);
}

/** A few event-loop turns, to let in-flight I/O land when nothing observable marks it. */
export async function turns(n = 50): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => setImmediate(r));
}

interface FakeTimer { id: number; at: number; ms: number; fn: () => void }

export class FakeTimers implements TimerApi {
  now = 1_700_000_000_000;
  private seq = 0;
  private timers: FakeTimer[] = [];
  /** Every delay ever requested, in order. */
  readonly requested: number[] = [];

  setTimeout(fn: () => void, ms: number): unknown {
    const t = { id: ++this.seq, at: this.now + ms, ms, fn };
    this.requested.push(ms);
    this.timers.push(t);
    return t.id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
  get pending(): number {
    return this.timers.length;
  }
  pendingDelays(): number[] {
    return this.timers.map((t) => t.ms);
  }
  /** Move time forward, firing due timers in order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = Math.max(this.now, due.at);
      due.fn();
    }
    this.now = target;
  }
}

export interface Conn {
  write(s: string | Buffer): void;
  end(): void;
  destroy(): void;
}

export type Script = (line: string, conn: Conn) => void;

export class FakeServer {
  readonly sockets = new Set<net.Socket>();
  readonly lines: string[] = [];
  bytes = 0;
  connections = 0;
  script: Script = () => undefined;
  private server = net.createServer((s) => this.onConnection(s));
  port = 0;

  private onConnection(s: net.Socket): void {
    this.connections++;
    this.sockets.add(s);
    s.on("error", () => undefined); // the client destroying its side is expected
    s.on("close", () => this.sockets.delete(s));
    let buf = "";
    s.on("data", (d: Buffer) => {
      this.bytes += d.length;
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.lines.push(line);
        this.script(line, {
          write: (x) => { if (!s.destroyed) s.write(x); },
          end: () => s.end(),
          destroy: () => s.destroy(),
        });
      }
    });
  }

  static async start(script?: Script): Promise<FakeServer> {
    const f = new FakeServer();
    if (script) f.script = script;
    await f.listen(0);
    return f;
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.server.listening ? this.server : net.createServer((s) => this.onConnection(s));
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.port = (this.server.address() as net.AddressInfo).port;
        resolve();
      });
    });
  }

  /** Stop accepting and drop every client. */
  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    if (this.server.listening) await new Promise<void>((r) => this.server.close(() => r()));
  }

  dropClients(): void {
    for (const s of this.sockets) s.destroy();
  }
}

/** A well-formed Liquidsoap answer. */
export const answer = (body: string, eol = "\n"): string => `${body}${eol}END${eol}`;

let assetSeq = 0;
export function makeAsset(path: string, durationS: number, over: Partial<Asset> = {}): Asset {
  const id = over.id ?? ++assetSeq;
  return {
    id, kind: "music", path, title: `Title ${id}`, artist: `Artist ${id}`, durationS,
    language: null, loudnessLufs: null, tags: [], ...over,
  };
}
