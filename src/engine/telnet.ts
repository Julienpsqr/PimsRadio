// SPDX-License-Identifier: AGPL-3.0-or-later
// Telnet transport to Liquidsoap (spec 001): one persistent connection, strictly serialised
// commands, timeouts, bounded sizes, reconnection with capped exponential backoff.
// No dependency beyond node:net. There is deliberately no way to send a raw line: callers
// pass a {@link Command} and only {@link renderCommand} builds what goes on the wire.
import net from "node:net";
import { EngineError, type EngineErrorCode } from "./engine.js";

/** The whole command whitelist. Nothing able to stop or reconfigure the engine is in it. */
export type Command =
  | { name: "push"; path: string }
  | { name: "queue" }
  | { name: "metadata"; rid: number }
  | { name: "skip" }
  | { name: "uptime" }
  | { name: "state" };

const WRITE_COMMANDS: ReadonlySet<Command["name"]> = new Set(["push", "skip"]);
export const MAX_PATH_BYTES = 4096;

/**
 * Check a path as seen by Liquidsoap. Nothing is cleaned up: a badly named file is a visible
 * error, never another file. Returns the reason, or null when the path is acceptable.
 */
export function pathProblem(path: string): string | null {
  if (typeof path !== "string") return "not a string";
  if (!path.startsWith("/")) return "must be absolute (start with /)";
  if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(path)) return "invalid unicode";
  if (Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES) return `longer than ${MAX_PATH_BYTES} bytes`;
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path)) return "contains a control character";
  if (path.split("/").includes("..")) return "contains a .. segment";
  if (/\s$/u.test(path)) return "ends with a space";
  return null;
}

/** Build the wire line (without the final newline). Re-validates everything: defence in depth. */
export function renderCommand(c: Command): string {
  switch (c.name) {
    case "push": {
      const problem = pathProblem(c.path);
      if (problem) throw new EngineError("invalid_input", `invalid path: ${problem}`);
      return `auto.push ${c.path}`;
    }
    case "queue":
      return "auto.queue";
    case "metadata":
      if (!Number.isInteger(c.rid) || c.rid < 0 || c.rid > 999_999_999) throw new EngineError("invalid_input", "invalid request id");
      return `request.metadata ${c.rid}`;
    case "skip":
      return "auto.skip";
    case "uptime":
      return "uptime";
    case "state":
      return "pims.state";
    default:
      throw new EngineError("invalid_input", "command not in the whitelist");
  }
}

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realTimers: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

export interface TelnetOptions {
  host: string;
  port: number;
  timers?: TimerApi;
  /** Wall clock in milliseconds (for `lastOkAt`). */
  now?: () => number;
  /** Uniform in [0, 1), for the backoff jitter. */
  random?: () => number;
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  maxPending?: number;
  maxResponseBytes?: number;
  maxLineBytes?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  backoffFactor?: number;
  backoffJitter?: number;
  /** Called when a connection is (re)established, before queued commands are sent. */
  onConnected?: () => void;
  log?: (level: "info" | "warn", message: string) => void;
}

export interface SendOptions {
  /** Overrides the command timeout (health probe). */
  timeoutMs?: number;
}

interface Pending {
  cmd: Command;
  line: string;
  write: boolean;
  timeoutMs: number;
  sent: boolean;
  timer: unknown;
  resolve: (lines: string[]) => void;
  reject: (e: EngineError) => void;
}

type State = "idle" | "connecting" | "up" | "down" | "closed";

/** Replace control characters so third-party text cannot forge log lines. */
export function safeForLog(s: string, max = 200): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?").slice(0, max);
}

export class TelnetLink {
  private readonly timers: TimerApi;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly commandTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly maxPending: number;
  private readonly maxResponseBytes: number;
  private readonly maxLineBytes: number;
  private readonly bo: { initial: number; max: number; factor: number; jitter: number };

  private state: State = "idle";
  private sock: net.Socket | undefined;
  private connectTimer: unknown;
  private reconnectTimer: unknown;
  private attempt = 0;
  private waiting: Pending[] = [];
  private inflight: Pending | undefined;
  private partial: Buffer = Buffer.alloc(0);
  private lines: string[] = [];
  private respBytes = 0;
  private lastOk: number | null = null;
  private lastErr: EngineErrorCode | null = null;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(private readonly o: TelnetOptions) {
    this.timers = o.timers ?? realTimers;
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.commandTimeoutMs = o.commandTimeoutMs ?? 3000;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 2000;
    this.maxPending = o.maxPending ?? 64;
    this.maxResponseBytes = o.maxResponseBytes ?? 1024 * 1024;
    this.maxLineBytes = o.maxLineBytes ?? 64 * 1024;
    this.bo = {
      initial: o.backoffInitialMs ?? 500, max: o.backoffMaxMs ?? 15_000,
      factor: o.backoffFactor ?? 2, jitter: o.backoffJitter ?? 0.2,
    };
  }

  /** Start connecting in the background (never throws, never blocks). */
  start(): void {
    if (this.state === "idle") this.connect();
  }

  get connected(): boolean {
    return this.state === "up";
  }
  /** True while the link is in the "down" state: calls fail immediately. */
  get isDown(): boolean {
    return this.state === "down";
  }
  get lastOkAt(): number | null {
    return this.lastOk;
  }
  get lastError(): EngineErrorCode | null {
    return this.lastErr;
  }

  /** Send one whitelisted command; resolves with the response lines (END excluded). */
  send(cmd: Command, opts: SendOptions = {}): Promise<string[]> {
    let line: string;
    try {
      line = renderCommand(cmd);
    } catch (e) {
      return Promise.reject(this.note(e as EngineError));
    }
    if (this.state === "closed") return Promise.reject(this.note(new EngineError("disconnected", "client closed")));
    if (this.state === "down") return Promise.reject(this.note(new EngineError("unreachable", "engine unreachable (reconnecting)")));
    if (this.waiting.length + (this.inflight ? 1 : 0) >= this.maxPending) {
      return Promise.reject(this.note(new EngineError("busy", "too many pending commands")));
    }
    if (this.state === "idle") this.connect();
    return new Promise<string[]>((resolve, reject) => {
      this.waiting.push({
        cmd, line, write: WRITE_COMMANDS.has(cmd.name), timeoutMs: opts.timeoutMs ?? this.commandTimeoutMs,
        sent: false, timer: undefined, resolve, reject,
      });
      this.pump();
    });
  }

  /** Politely leave (`exit`), destroy the socket, stop every timer. Idempotent. */
  async close(): Promise<void> {
    if (this.state === "closed") return;
    const sock = this.sock;
    const wasUp = this.state === "up" && !this.inflight;
    this.failAll("client closed");
    this.state = "closed";
    this.clearTimers();
    this.sock = undefined;
    if (!sock) return;
    await new Promise<void>((resolve) => {
      sock.once("close", () => resolve());
      sock.on("error", () => { /* closing anyway */ });
      if (wasUp && !sock.destroyed) sock.write("exit\n", () => sock.destroy());
      else sock.destroy();
    });
  }

  // ------------------------------------------------------------------ internals
  private note(e: EngineError): EngineError {
    this.lastErr = e.code;
    return e;
  }

  private clearTimers(): void {
    if (this.connectTimer !== undefined) this.timers.clearTimeout(this.connectTimer);
    if (this.reconnectTimer !== undefined) this.timers.clearTimeout(this.reconnectTimer);
    this.connectTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private connect(): void {
    this.state = "connecting";
    const sock = net.createConnection({ host: this.o.host, port: this.o.port });
    this.sock = sock;
    sock.setNoDelay(true);
    this.connectTimer = this.timers.setTimeout(() => {
      this.connectTimer = undefined;
      this.drop(sock, "connect timeout");
    }, this.connectTimeoutMs);
    sock.once("connect", () => {
      if (this.sock !== sock) return;
      this.timers.clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
      this.state = "up";
      this.attempt = 0;
      this.resetReader();
      this.o.log?.("info", `telnet connected to ${safeForLog(this.o.host)}:${this.o.port}`);
      try {
        this.o.onConnected?.();
      } catch (e) {
        this.o.log?.("warn", `onConnected hook failed: ${safeForLog(String(e))}`);
      }
      this.pump();
    });
    sock.on("data", (chunk: Buffer) => this.onData(sock, chunk));
    sock.on("error", (e: Error) => {
      // 'close' always follows; the failure is handled there. Keep the code for the log only.
      this.o.log?.("warn", `telnet socket error: ${safeForLog((e as NodeJS.ErrnoException).code ?? e.message)}`);
    });
    sock.on("close", () => this.drop(sock, "connection closed"));
  }

  private resetReader(): void {
    this.partial = Buffer.alloc(0);
    this.lines = [];
    this.respBytes = 0;
  }

  /**
   * The only way a connection ends: every doubtful situation lands here. Destroys the socket
   * (never reused), settles every command exactly once, plans the reconnection.
   */
  private drop(sock: net.Socket, why: string, inflightError?: EngineError): void {
    if (this.sock !== sock) return; // an old socket reporting late
    const wasConnecting = this.state === "connecting";
    this.sock = undefined;
    this.clearTimers();
    sock.destroy();
    if (this.state === "closed") return;
    this.state = "down";
    this.resetReader();
    const inflight = this.inflight;
    this.inflight = undefined;
    if (inflight) {
      this.timers.clearTimeout(inflight.timer);
      inflight.reject(this.note(inflightError ?? new EngineError("disconnected", "connection lost during a command", inflight.write)));
    }
    const rest = this.waiting;
    this.waiting = [];
    for (const p of rest) {
      p.reject(this.note(wasConnecting
        ? new EngineError("unreachable", "engine unreachable")
        : new EngineError("disconnected", "connection lost before the command was sent")));
    }
    this.o.log?.("warn", `telnet link down (${why}); reconnecting`);
    this.scheduleReconnect();
  }

  private backoffDelay(): number {
    const base = Math.min(this.bo.max, this.bo.initial * this.bo.factor ** this.attempt);
    const jitter = 1 + this.bo.jitter * (2 * this.random() - 1);
    return Math.round(base * jitter);
  }

  private scheduleReconnect(): void {
    const delay = this.backoffDelay();
    this.attempt++;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.state === "down") this.connect();
    }, delay);
  }

  private failAll(message: string): void {
    const inflight = this.inflight;
    this.inflight = undefined;
    if (inflight) {
      this.timers.clearTimeout(inflight.timer);
      inflight.reject(this.note(new EngineError("disconnected", message, inflight.write)));
    }
    const rest = this.waiting;
    this.waiting = [];
    for (const p of rest) p.reject(this.note(new EngineError("disconnected", message)));
  }

  private pump(): void {
    if (this.state !== "up" || this.inflight || !this.sock) return;
    const next = this.waiting.shift();
    if (!next) return;
    const sock = this.sock;
    this.inflight = next;
    next.sent = true;
    next.timer = this.timers.setTimeout(() => {
      if (this.inflight !== next) return;
      this.drop(sock, "command timeout", new EngineError("timeout", "command timed out", next.write));
    }, next.timeoutMs);
    sock.write(`${next.line}\n`);
  }

  private onData(sock: net.Socket, chunk: Buffer): void {
    if (this.sock !== sock || this.state !== "up") return;
    const buf = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl < 0) break;
      let end = nl;
      if (end > start && buf[end - 1] === 0x0d) end--;
      if (end - start > this.maxLineBytes) return this.protocolError(sock, "line too long");
      let text: string;
      try {
        text = this.decoder.decode(buf.subarray(start, end));
      } catch {
        return this.protocolError(sock, "invalid UTF-8");
      }
      const lineBytes = nl + 1 - start;
      start = nl + 1;
      if (!this.inflight) return this.protocolError(sock, "unsolicited data");
      if (text === "END") {
        const p = this.inflight;
        const lines = this.lines;
        this.inflight = undefined;
        this.lines = [];
        this.respBytes = 0;
        this.timers.clearTimeout(p.timer);
        this.lastOk = this.now();
        this.lastErr = null;
        p.resolve(lines);
        // Only one command is ever in flight: bytes after its END cannot be a legitimate answer.
        if (start < buf.length) return this.protocolError(sock, "unsolicited data");
        this.pump();
        continue;
      }
      this.respBytes += lineBytes;
      if (this.respBytes > this.maxResponseBytes) return this.protocolError(sock, "response too large");
      this.lines.push(text);
    }
    const rest = buf.subarray(start);
    if (rest.length > this.maxLineBytes) return this.protocolError(sock, "line too long");
    // Copy: the chunk's memory must not be pinned by a small tail.
    this.partial = Buffer.from(rest);
    if (rest.length > 0 && !this.inflight) this.protocolError(sock, "unsolicited data");
  }

  private protocolError(sock: net.Socket, why: string): void {
    const p = this.inflight;
    this.drop(sock, why, p ? new EngineError("protocol", `protocol error: ${why}`, p.write) : undefined);
  }
}
