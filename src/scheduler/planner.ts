// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "../db/db.js";
import { type AudioEngine, EngineError } from "../engine/engine.js";
import type { Library } from "../library/library.js";
import { type Grid, resolveSlot } from "./grid.js";
import { DEFAULT_RULES, type PlayedEntry, type RotationRules, pickNext } from "./rotation.js";

export interface PlannerOptions {
  timeZone: string;
  /** Keep at least this many seconds queued ahead (control plane may go down). */
  targetAheadS: number;
  rules?: RotationRules;
  rng?: () => number;
}

export interface TickResult {
  pushed: number;
  note?: string;
}

/**
 * Fills the engine queue ahead of time. It is never in the audio path:
 * if it stops, the engine keeps playing what is already queued, then falls back.
 */
export class Planner {
  constructor(
    private readonly db: Db,
    private readonly grid: Grid,
    private readonly library: Library,
    private readonly engine: AudioEngine,
    private readonly opts: PlannerOptions,
  ) {}

  private history(): PlayedEntry[] {
    const rows = this.db
      .prepare(
        `SELECT l.asset_id AS assetId, a.artist AS artist, l.started_at AS startedAt
         FROM play_log l JOIN asset a ON a.id = l.asset_id
         ORDER BY l.id DESC LIMIT 500`,
      )
      .all() as unknown as { assetId: number; artist: string; startedAt: string }[];
    return rows.map((r) => ({ assetId: r.assetId, artist: r.artist, playedAt: new Date(r.startedAt) }));
  }

  /**
   * Never throws because of the engine (spec 001): an unreachable or confused engine ends the
   * tick with a note, and the caller simply retries on its next tick. A push whose outcome is
   * unknown stops the tick; the next one re-reads the real queue, which avoids duplicates.
   */
  async tick(now: Date): Promise<TickResult> {
    let pushed = 0;
    try {
      return await this.fill(now, (n) => { pushed = n; });
    } catch (e) {
      if (!(e instanceof EngineError)) throw e;
      const what = e.code === "invalid_input" ? "engine rejected a track" : "engine unreachable";
      return { pushed, note: `${what}: ${e.code}${e.maybeApplied ? " (outcome of the last push unknown)" : ""}` };
    }
  }

  private async fill(now: Date, report: (pushed: number) => void): Promise<TickResult> {
    let ahead = await this.engine.queuedSeconds();
    let pushed = 0;
    const slots = this.grid.all();
    while (ahead < this.opts.targetAheadS && pushed < 50) {
      const at = new Date(now.getTime() + ahead * 1000);
      const slot = resolveSlot(slots, at, this.opts.timeZone);
      if (slot && (slot.kind === "stream" || slot.kind === "live")) {
        // Switching to external sources is the engine's job (phase 3).
        return { pushed, note: `slot ${slot.id} is ${slot.kind}: nothing to queue` };
      }
      const pool = this.library.list("music", slot?.ref ?? undefined);
      const asset = pickNext(pool, this.history(), at, this.opts.rules ?? DEFAULT_RULES, this.opts.rng);
      if (!asset) return { pushed, note: "no music in library: engine will use its fallback folder" };
      await this.engine.push(asset);
      this.db
        .prepare("INSERT INTO play_log (started_at, asset_id, origin, slot_id) VALUES (?, ?, 'auto', ?)")
        .run(at.toISOString(), asset.id, slot?.id ?? null);
      ahead += asset.durationS;
      pushed++;
      report(pushed);
    }
    return { pushed };
  }
}
