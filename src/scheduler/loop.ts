// SPDX-License-Identifier: AGPL-3.0-or-later
// PlannerLoop (spec 022): calls the planner periodically. It is never in the audio path
// (ADR 0001): if it stops or fails, the engine plays what is queued, then its fallback folder.
import { realTimers, safeForLog, type TimerApi } from "../engine/telnet.js";
import type { TickResult } from "./planner.js";

export interface PlannerStatus {
  running: boolean;
  /** A tick has been running for longer than `stallAfterMs`. No second tick is started meanwhile. */
  stalled: boolean;
  lastTickAt: string | null;
  lastOkAt: string | null;
  lastPushed: number;
  /** Fixed string coming from the planner (never a raw error message), or null. */
  note: string | null;
  consecutiveFailures: number;
}

export interface PlannerLoopOptions {
  tick: (now: Date) => Promise<TickResult>;
  intervalMs: number;
  /** Default 60 000. */
  stallAfterMs?: number;
  /** Max wait for the running tick in `stop()`. Default 5 000. */
  stopTimeoutMs?: number;
  timers?: TimerApi;
  now?: () => Date;
  log?: (level: "info" | "warn", message: string) => void;
}

export class PlannerLoop {
  private readonly timers: TimerApi;
  private readonly now: () => Date;
  private readonly stallAfterMs: number;
  private readonly stopTimeoutMs: number;
  private state: "idle" | "running" | "stopped" = "idle";
  private nextTimer: unknown;
  private stallTimer: unknown;
  private inFlight: Promise<void> | null = null;
  private stalled = false;
  private lastTickAt: string | null = null;
  private lastOkAt: string | null = null;
  private lastPushed = 0;
  private note: string | null = null;
  private failures = 0;

  constructor(private readonly o: PlannerLoopOptions) {
    this.timers = o.timers ?? realTimers;
    this.now = o.now ?? (() => new Date());
    this.stallAfterMs = o.stallAfterMs ?? 60_000;
    this.stopTimeoutMs = o.stopTimeoutMs ?? 5_000;
  }

  /** Returns at once; the first tick runs in the background. A stopped loop cannot be restarted. */
  start(): void {
    if (this.state !== "idle") return;
    this.state = "running";
    this.schedule(0);
  }

  /** Cancels the timer, forbids new ticks, waits (bounded) for the running tick. Idempotent. */
  async stop(): Promise<void> {
    this.state = "stopped";
    if (this.nextTimer !== undefined) this.timers.clearTimeout(this.nextTimer);
    this.nextTimer = undefined;
    const pending = this.inFlight;
    if (!pending) return;
    let timer: unknown;
    const limit = new Promise<void>((resolve) => { timer = this.timers.setTimeout(resolve, this.stopTimeoutMs); });
    try {
      await Promise.race([pending, limit]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  status(): PlannerStatus {
    return {
      running: this.state === "running",
      stalled: this.stalled,
      lastTickAt: this.lastTickAt,
      lastOkAt: this.lastOkAt,
      lastPushed: this.lastPushed,
      note: this.note,
      consecutiveFailures: this.failures,
    };
  }

  private schedule(ms: number): void {
    if (this.state !== "running") return;
    this.nextTimer = this.timers.setTimeout(() => {
      this.nextTimer = undefined;
      this.inFlight = this.runOnce().finally(() => {
        this.inFlight = null;
        this.schedule(this.o.intervalMs);
      });
    }, ms);
  }

  private async runOnce(): Promise<void> {
    const started = this.now();
    this.lastTickAt = started.toISOString();
    this.stallTimer = this.timers.setTimeout(() => {
      this.stalled = true;
      this.o.log?.("warn", "planner tick is taking too long (no second tick is started)");
    }, this.stallAfterMs);
    try {
      const r = await this.o.tick(started);
      this.lastOkAt = this.now().toISOString();
      this.lastPushed = r.pushed;
      this.note = r.note ?? null;
      this.failures = 0;
    } catch (e) {
      this.failures++;
      this.lastPushed = 0;
      this.note = null;
      const what = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.o.log?.("warn", `planner tick failed (${this.failures} in a row): ${safeForLog(what)}`);
    } finally {
      this.timers.clearTimeout(this.stallTimer);
      this.stallTimer = undefined;
      this.stalled = false;
    }
  }
}
