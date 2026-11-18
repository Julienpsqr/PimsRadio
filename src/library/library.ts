// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Db } from "../db/db.js";

export const ASSET_KINDS = ["music", "jingle", "sweeper", "sponsor", "show", "speech"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

export interface Asset {
  id: number;
  kind: AssetKind;
  path: string;
  title: string;
  artist: string;
  durationS: number;
  language: string | null;
  loudnessLufs: number | null;
  tags: string[];
}

export interface NewAsset {
  kind: AssetKind;
  path: string;
  title: string;
  artist?: string;
  durationS: number;
  language?: string | null;
  loudnessLufs?: number | null;
  tags?: string[];
}

interface Row {
  id: number; kind: AssetKind; path: string; title: string; artist: string;
  duration_s: number; language: string | null; loudness_lufs: number | null; tags: string;
}

const fromRow = (r: Row): Asset => ({
  id: r.id, kind: r.kind, path: r.path, title: r.title, artist: r.artist,
  durationS: r.duration_s, language: r.language, loudnessLufs: r.loudness_lufs,
  tags: JSON.parse(r.tags) as string[],
});

export class Library {
  constructor(private readonly db: Db) {}

  add(a: NewAsset): Asset {
    if (!ASSET_KINDS.includes(a.kind)) throw new Error(`invalid asset kind: ${a.kind}`);
    if (!a.title.trim()) throw new Error("title is required");
    const res = this.db
      .prepare(
        `INSERT INTO asset (kind, path, title, artist, duration_s, language, loudness_lufs, tags, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.kind, a.path, a.title.trim(), (a.artist ?? "").trim(), a.durationS,
        a.language ?? null, a.loudnessLufs ?? null, JSON.stringify(a.tags ?? []), new Date().toISOString());
    return this.get(Number(res.lastInsertRowid))!;
  }

  get(id: number): Asset | null {
    const r = this.db.prepare("SELECT * FROM asset WHERE id = ?").get(id) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  /** List assets of a kind, optionally restricted to those carrying a tag. */
  list(kind: AssetKind, tag?: string): Asset[] {
    const rows = this.db.prepare("SELECT * FROM asset WHERE kind = ? ORDER BY id").all(kind) as unknown as Row[];
    const all = rows.map(fromRow);
    return tag ? all.filter((a) => a.tags.includes(tag)) : all;
  }

  remove(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM asset WHERE id = ?").run(id).changes) > 0;
  }
}
