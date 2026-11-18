// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "./db.js";

test("migrations are applied once and are idempotent", () => {
  const db = openDb(":memory:");
  const n = (db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as { n: number }).n;
  assert.equal(n, 1);
  assert.doesNotThrow(() => db.prepare("SELECT * FROM asset").all());
});

test("a failing migration is rolled back", () => {
  assert.throws(() =>
    openDb(":memory:", [{ id: 1, name: "bad", sql: "CREATE TABLE a (x INTEGER); CREATE TABLE a (y INTEGER);" }]),
  );
});

test("slot constraints reject an inverted time range", () => {
  const db = openDb(":memory:");
  assert.throws(() =>
    db.prepare("INSERT INTO slot (weekday,start_min,end_min,kind) VALUES (1, 600, 600, 'rotation')").run(),
  );
});
