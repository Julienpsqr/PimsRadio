// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "../db/db.js";

export type SlotKind = "rotation" | "playlist" | "stream" | "live";

export interface Slot {
  id: number;
  weekday: number; // 1 = Monday .. 7 = Sunday
  startMin: number;
  endMin: number;
  kind: SlotKind;
  ref: string | null;
  state: "draft" | "published";
}

export interface LocalParts {
  weekday: number;
  minutes: number;
}

const WD: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Weekday and minutes-since-midnight of an instant in the station's time zone. */
export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { weekday: WD[get("weekday")]!, minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

// Higher wins when several published slots overlap: live > stream > playlist > rotation.
const PRIORITY: Record<SlotKind, number> = { live: 4, stream: 3, playlist: 2, rotation: 1 };

/** The published slot on air at `date`, or null (the engine then uses its fallback). */
export function resolveSlot(slots: Slot[], date: Date, timeZone: string): Slot | null {
  const { weekday, minutes } = localParts(date, timeZone);
  const hits = slots.filter(
    (s) => s.state === "published" && s.weekday === weekday && s.startMin <= minutes && minutes < s.endMin,
  );
  hits.sort((a, b) => PRIORITY[b.kind] - PRIORITY[a.kind] || b.startMin - a.startMin || b.id - a.id);
  return hits[0] ?? null;
}

interface SlotRow {
  id: number; weekday: number; start_min: number; end_min: number; kind: SlotKind;
  ref: string | null; state: "draft" | "published";
}

export class Grid {
  constructor(private readonly db: Db) {}

  add(s: Omit<Slot, "id" | "state"> & { state?: Slot["state"] }): Slot {
    const res = this.db
      .prepare("INSERT INTO slot (weekday, start_min, end_min, kind, ref, state) VALUES (?, ?, ?, ?, ?, ?)")
      .run(s.weekday, s.startMin, s.endMin, s.kind, s.ref, s.state ?? "draft");
    return this.all().find((x) => x.id === Number(res.lastInsertRowid))!;
  }

  publishAll(): number {
    return Number(this.db.prepare("UPDATE slot SET state = 'published' WHERE state = 'draft'").run().changes);
  }

  all(): Slot[] {
    const rows = this.db.prepare("SELECT * FROM slot ORDER BY weekday, start_min").all() as unknown as SlotRow[];
    return rows.map((r) => ({
      id: r.id, weekday: r.weekday, startMin: r.start_min, endMin: r.end_min,
      kind: r.kind, ref: r.ref, state: r.state,
    }));
  }
}
