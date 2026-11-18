// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Asset } from "../library/library.js";

/**
 * The audio plane, seen from the control plane (ADR 0001).
 * The real implementation drives Liquidsoap; the control plane must keep
 * working (and the engine keep playing) if the other side is down.
 */
export interface AudioEngine {
  /** Append a track to the playout queue. */
  push(asset: Asset): Promise<void>;
  /** Seconds of audio already queued ahead of what is playing. */
  queuedSeconds(): Promise<number>;
  /** Is the engine reachable and producing sound? */
  healthy(): Promise<boolean>;
}

/** In-memory engine for tests and for developing without Docker. */
export class FakeEngine implements AudioEngine {
  readonly queue: Asset[] = [];
  up = true;

  async push(asset: Asset): Promise<void> {
    if (!this.up) throw new Error("engine unreachable");
    this.queue.push(asset);
  }
  async queuedSeconds(): Promise<number> {
    if (!this.up) throw new Error("engine unreachable");
    return this.queue.reduce((s, a) => s + a.durationS, 0);
  }
  async healthy(): Promise<boolean> {
    return this.up;
  }
}
