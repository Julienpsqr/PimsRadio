// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db/db.js";
import { EngineError, FakeEngine } from "../engine/engine.js";
import { Library } from "../library/library.js";
import { Grid } from "./grid.js";
import { Planner } from "./planner.js";

function setup() {
  const db = openDb(":memory:");
  const lib = new Library(db);
  const grid = new Grid(db);
  const engine = new FakeEngine();
  for (let i = 1; i <= 6; i++) lib.add({ kind: "music", path: `/m/${i}`, title: `T${i}`, artist: `Art${i}`, durationS: 200 });
  const planner = new Planner(db, grid, lib, engine, { timeZone: "Europe/Paris", targetAheadS: 900, rng: () => 0 });
  return { db, lib, grid, engine, planner };
}
const now = new Date("2026-07-01T10:00:00Z");

test("fills the queue to the target and logs what it queued", async () => {
  const { db, engine, planner } = setup();
  const r = await planner.tick(now);
  assert.equal(r.pushed, 5); // 5 x 200 s >= 900 s
  assert.equal(engine.pushed.length, 5);
  assert.equal(new Set(engine.pushed.map((a) => a.id)).size, 5, "no repeat within the window");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM play_log").get() as { n: number }).n, 5);
  assert.equal((await planner.tick(now)).pushed, 0, "already full");
});

test("empty library: nothing pushed, explains why (engine falls back)", async () => {
  const db = openDb(":memory:");
  const engine = new FakeEngine();
  const p = new Planner(db, new Grid(db), new Library(db), engine, { timeZone: "Europe/Paris", targetAheadS: 900 });
  const r = await p.tick(now);
  assert.equal(r.pushed, 0);
  assert.match(r.note ?? "", /fallback/);
});

test("a stream slot is not filled with music", async () => {
  const { grid, planner, engine } = setup();
  grid.add({ weekday: 3, startMin: 0, endMin: 1440, kind: "stream", ref: "radio-x", state: "published" });
  const r = await planner.tick(now);
  assert.equal(r.pushed, 0);
  assert.equal(engine.pushed.length, 0);
});

test("an unreachable engine ends the tick with a note, never an exception, and logs nothing", async () => {
  const { db, planner, engine } = setup();
  engine.up = false;
  const r = await planner.tick(now);
  assert.equal(r.pushed, 0);
  assert.match(r.note ?? "", /^engine unreachable: unreachable/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM play_log").get() as { n: number }).n, 0);
  engine.up = true;
  assert.equal((await planner.tick(now)).pushed, 5, "the next tick works once the engine is back");
});

test("a failing push writes no play_log row and stops the tick", async () => {
  const { db, planner, engine } = setup();
  let calls = 0;
  const realPush = engine.push.bind(engine);
  engine.push = async (a) => {
    if (++calls === 3) throw new EngineError("timeout", "slow", true);
    return realPush(a);
  };
  const r = await planner.tick(now);
  assert.equal(r.pushed, 2);
  assert.match(r.note ?? "", /engine unreachable: timeout \(outcome of the last push unknown\)/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM play_log").get() as { n: number }).n, 2);
});

test("an engine that already holds enough audio makes the tick push nothing (control plane restart)", async () => {
  const { planner, engine, lib } = setup();
  for (const a of lib.list("music").slice(0, 5)) await engine.push(a); // 5 x 200 s already queued
  assert.equal((await planner.tick(now)).pushed, 0);
});

test("errors that are not the engine's still surface", async () => {
  const { planner, engine } = setup();
  engine.queuedSeconds = async () => { throw new Error("bug"); };
  await assert.rejects(planner.tick(now), /bug/);
});
