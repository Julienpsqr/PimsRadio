// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db/db.js";
import { EngineError, FakeEngine } from "../engine/engine.js";
import { FakeTimers, turns } from "../engine/test-support.js";
import { Library } from "../library/library.js";
import { Grid } from "./grid.js";
import { PlannerLoop } from "./loop.js";
import { Planner, type TickResult } from "./planner.js";

function make(tick: (now: Date) => Promise<TickResult>, over: { stallAfterMs?: number; stopTimeoutMs?: number } = {}) {
  const timers = new FakeTimers();
  const logs: string[] = [];
  const loop = new PlannerLoop({
    tick, intervalMs: 30_000, timers, now: () => new Date(timers.now), log: (_l, m) => logs.push(m), ...over,
  });
  return { timers, logs, loop };
}

test("1. start returns at once; first tick in the background, then one per interval", async () => {
  let calls = 0;
  const { timers, loop } = make(async () => { calls++; return { pushed: 1 }; });
  loop.start();
  assert.equal(calls, 0, "start does not run the tick synchronously");
  timers.advance(0);
  await turns();
  assert.equal(calls, 1);
  timers.advance(29_999);
  await turns();
  assert.equal(calls, 1);
  timers.advance(1);
  await turns();
  assert.equal(calls, 2);
  assert.equal(loop.status().lastPushed, 1);
  await loop.stop();
});

test("2. ticks never overlap: a slow tick delays the next one", async () => {
  let active = 0, maxActive = 0, calls = 0;
  let release: () => void = () => {};
  const { timers, loop } = make(async () => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    await new Promise<void>((r) => { release = r; });
    active--;
    return { pushed: 0 };
  });
  loop.start();
  timers.advance(0);
  await turns();
  timers.advance(120_000); // far beyond the interval while the first tick is still running
  await turns();
  assert.equal(calls, 1);
  release();
  await turns();
  timers.advance(30_000);
  await turns();
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  release();
  await loop.stop();
});

test("3. an exception is caught, logged clean, counted; the loop goes on and a success resets", async () => {
  let n = 0;
  const { timers, logs, loop } = make(async () => {
    n++;
    if (n <= 2) throw new Error("db\nlocked\u0000" + "x".repeat(500));
    return { pushed: 2 };
  });
  loop.start();
  timers.advance(0); await turns();
  assert.equal(loop.status().consecutiveFailures, 1);
  timers.advance(30_000); await turns();
  assert.equal(loop.status().consecutiveFailures, 2);
  assert.equal(logs.length, 2);
  for (const l of logs) {
    assert.ok(!/[\u0000-\u001f]/.test(l), "no control character in the log");
    assert.ok(l.length < 400, "bounded log line");
  }
  timers.advance(30_000); await turns();
  const s = loop.status();
  assert.equal(s.consecutiveFailures, 0);
  assert.equal(s.lastPushed, 2);
  assert.equal(s.running, true);
  await loop.stop();
});

test("4. a planner note is kept and is not a failure", async () => {
  const { timers, loop } = make(async () => ({ pushed: 0, note: "engine unreachable: unreachable" }));
  loop.start();
  timers.advance(0); await turns();
  const s = loop.status();
  assert.equal(s.note, "engine unreachable: unreachable");
  assert.equal(s.consecutiveFailures, 0);
  assert.notEqual(s.lastOkAt, null);
  await loop.stop();
});

test("5. a stuck tick is reported as stalled, never doubled; cleared when it ends", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const { timers, loop } = make(async () => {
    calls++;
    await new Promise<void>((r) => { release = r; });
    return { pushed: 0 };
  }, { stallAfterMs: 60_000 });
  loop.start();
  timers.advance(0); await turns();
  timers.advance(59_999);
  assert.equal(loop.status().stalled, false);
  timers.advance(1);
  assert.equal(loop.status().stalled, true);
  timers.advance(300_000); await turns();
  assert.equal(calls, 1, "no second tick while the first one is stuck");
  release(); await turns();
  assert.equal(loop.status().stalled, false);
  await loop.stop();
});

test("6. stop: no more ticks, waits for the running tick (bounded), idempotent, no restart", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const { timers, loop } = make(async () => {
    calls++;
    await new Promise<void>((r) => { release = r; });
    return { pushed: 0 };
  }, { stopTimeoutMs: 5_000 });
  loop.start();
  timers.advance(0); await turns();
  let stopped = false;
  const p = loop.stop().then(() => { stopped = true; });
  await turns();
  assert.equal(stopped, false, "waits for the running tick");
  release(); await p;
  assert.equal(stopped, true);
  timers.advance(300_000); await turns();
  assert.equal(calls, 1);
  assert.equal(timers.pending, 0, "no timer left behind");
  await loop.stop(); // idempotent
  loop.start(); // a stopped loop stays stopped
  timers.advance(300_000); await turns();
  assert.equal(calls, 1);
  assert.equal(loop.status().running, false);

  // A tick that never ends cannot block the shutdown for longer than stopTimeoutMs.
  const hung = make(() => new Promise<TickResult>(() => {}), { stopTimeoutMs: 5_000 });
  hung.loop.start();
  hung.timers.advance(0); await turns();
  let done = false;
  const q = hung.loop.stop().then(() => { done = true; });
  await turns();
  assert.equal(done, false);
  hung.timers.advance(5_000);
  await q;
  assert.equal(done, true);
});

test("9. integration: planner + engine; an outage is survived without restart", async () => {
  const db = openDb(":memory:");
  const lib = new Library(db);
  const grid = new Grid(db);
  const engine = new FakeEngine();
  for (let i = 1; i <= 6; i++) lib.add({ kind: "music", path: `/m/${i}`, title: `T${i}`, artist: `A${i}`, durationS: 200 });
  const planner = new Planner(db, grid, lib, engine, { timeZone: "Europe/Paris", targetAheadS: 900, rng: () => 0 });
  const { timers, loop } = make((now) => planner.tick(now));
  engine.up = false;
  loop.start();
  timers.advance(0); await turns();
  assert.equal(engine.pushed.length, 0);
  assert.match(loop.status().note ?? "", /unreachable/);
  assert.equal(loop.status().consecutiveFailures, 0, "an unreachable engine is a note, not a crash");
  engine.up = true;
  timers.advance(30_000); await turns();
  assert.ok(engine.pushed.length >= 4, "queue filled at the next tick");
  assert.equal(loop.status().note, null);
  await loop.stop();
  assert.ok(new EngineError("timeout", "x"));
});
