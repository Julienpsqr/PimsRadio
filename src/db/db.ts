// SPDX-License-Identifier: AGPL-3.0-or-later
import { DatabaseSync } from "node:sqlite";

/** A schema migration. Never edit a published migration: add a new one. */
export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "initial",
    sql: `
      CREATE TABLE asset (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('music','jingle','sweeper','sponsor','show','speech')),
        path TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        artist TEXT NOT NULL DEFAULT '',
        duration_s REAL NOT NULL CHECK (duration_s >= 0),
        language TEXT,
        loudness_lufs REAL,
        tags TEXT NOT NULL DEFAULT '[]',
        added_at TEXT NOT NULL
      );
      CREATE INDEX asset_kind ON asset(kind);

      CREATE TABLE stream_source (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        authorization_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      -- weekday: 1 = Monday .. 7 = Sunday (ISO). Minutes since local midnight.
      CREATE TABLE slot (
        id INTEGER PRIMARY KEY,
        weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
        start_min INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
        end_min INTEGER NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
        kind TEXT NOT NULL CHECK (kind IN ('rotation','playlist','stream','live')),
        ref TEXT,
        state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','published')),
        CHECK (end_min > start_min)
      );

      CREATE TABLE play_log (
        id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        asset_id INTEGER REFERENCES asset(id),
        origin TEXT NOT NULL CHECK (origin IN ('auto','live','stream','fallback')),
        slot_id INTEGER REFERENCES slot(id)
      );
      CREATE INDEX play_log_started ON play_log(started_at);
    `,
  },
];

export type Db = DatabaseSync;

/** Open (and migrate) the database. Use ":memory:" in tests. */
export function openDb(path: string, migrations: Migration[] = MIGRATIONS): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const done = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id),
  );
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (done.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)").run(
        m.id,
        m.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}
