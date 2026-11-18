// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db/db.js";
import { Grid, localParts, resolveSlot } from "./grid.js";

const TZ = "Europe/Paris";

test("localParts uses the station time zone (summer: UTC+2)", () => {
  // 2026-07-01 is a Wednesday; 10:30 UTC = 12:30 in Paris
  assert.deepEqual(localParts(new Date("2026-07-01T10:30:00Z"), TZ), { weekday: 3, minutes: 12 * 60 + 30 });
});

test("localParts handles winter time (UTC+1) and Sunday = 7", () => {
  assert.deepEqual(localParts(new Date("2026-12-06T23:30:00Z"), TZ), { weekday: 1, minutes: 30 }); // Mon 00:30 Paris
  assert.equal(localParts(new Date("2026-12-06T12:00:00Z"), TZ).weekday, 7);
});

test("only published slots count; live beats stream beats rotation", () => {
  const grid = new Grid(openDb(":memory:"));
  grid.add({ weekday: 3, startMin: 0, endMin: 1440, kind: "rotation", ref: null });
  grid.add({ weekday: 3, startMin: 720, endMin: 780, kind: "stream", ref: "radio-x" });
  grid.add({ weekday: 3, startMin: 740, endMin: 760, kind: "live", ref: null });
  const at = (iso: string) => resolveSlot(grid.all(), new Date(iso), TZ)?.kind ?? null;
  assert.equal(at("2026-07-01T10:30:00Z"), null); // nothing published yet
  grid.publishAll();
  assert.equal(at("2026-07-01T09:00:00Z"), "rotation"); // 11:00
  assert.equal(at("2026-07-01T10:10:00Z"), "stream"); // 12:10
  assert.equal(at("2026-07-01T10:25:00Z"), "live"); // 12:25
});

test("slot end is exclusive", () => {
  const grid = new Grid(openDb(":memory:"));
  grid.add({ weekday: 3, startMin: 720, endMin: 780, kind: "playlist", ref: "p", state: "published" });
  assert.ok(resolveSlot(grid.all(), new Date("2026-07-01T10:59:00Z"), TZ)); // 12:59
  assert.equal(resolveSlot(grid.all(), new Date("2026-07-01T11:00:00Z"), TZ), null); // 13:00
});
