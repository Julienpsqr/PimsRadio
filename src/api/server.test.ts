// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { openDb } from "../db/db.js";
import { FakeEngine } from "../engine/engine.js";
import { Grid } from "../scheduler/grid.js";
import { createApi } from "./server.js";

async function start() {
  const db = openDb(":memory:");
  const engine = new FakeEngine();
  const grid = new Grid(db);
  grid.add({ weekday: 3, startMin: 0, endMin: 1440, kind: "rotation", ref: null, state: "published" });
  const server = createApi({ engine, grid, timeZone: "Europe/Paris", version: "t", now: () => new Date("2026-07-01T10:00:00Z") });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { engine, base, close: () => server.close() };
}

test("health reports the control plane and the engine separately", async () => {
  const { engine, base, close } = await start();
  const up = await fetch(`${base}/api/health`);
  assert.equal(up.status, 200);
  assert.deepEqual(await up.json(), { ok: true, version: "t", engine: true, engineDetail: { connected: true, lastOkAt: null, lastError: null } });
  engine.up = false;
  const down = await fetch(`${base}/api/health`);
  assert.equal(down.status, 200, "an unreachable engine is reported, not an HTTP error");
  assert.deepEqual(await down.json(), { ok: true, version: "t", engine: false, engineDetail: { connected: false, lastOkAt: null, lastError: "unreachable" } });
  close();
});

test("now returns the slot on air; unknown routes give 404", async () => {
  const { base, close } = await start();
  const now = (await (await fetch(`${base}/api/now`)).json()) as { slot: { kind: string } };
  assert.equal(now.slot.kind, "rotation");
  assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  close();
});

test("health stays 200 with engine=false and no raw message when the engine misbehaves", async () => {
  const db = openDb(":memory:");
  const engine = new FakeEngine();
  engine.healthy = async () => { throw new Error("secret /media/path detail"); };
  engine.detail = () => { throw new Error("secret /media/path detail"); };
  const server = createApi({ engine, grid: new Grid(db), timeZone: "Europe/Paris", version: "t" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await fetch(`${base}/api/health`);
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(text), { ok: true, version: "t", engine: false });
  assert.ok(!text.includes("secret"));
  server.close();
});

test("7. health exposes the planner state with fixed fields only, and is unchanged without it", async () => {
  const db = openDb(":memory:");
  const status = { running: true, stalled: false, lastTickAt: "2026-07-01T10:00:00.000Z", lastOkAt: null, lastPushed: 3, note: null, consecutiveFailures: 1 };
  const withLoop = createApi({ engine: new FakeEngine(), grid: new Grid(db), timeZone: "Europe/Paris", version: "t", planner: () => status });
  const broken = createApi({ engine: new FakeEngine(), grid: new Grid(db), timeZone: "Europe/Paris", version: "t", planner: () => { throw new Error("secret"); } });
  const bodies: unknown[] = [];
  let text = "";
  for (const s of [withLoop, broken]) {
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/api/health`);
    text = await res.text();
    assert.equal(res.status, 200);
    bodies.push(JSON.parse(text));
    s.close();
  }
  assert.deepEqual((bodies[0] as { planner: unknown }).planner, status);
  assert.equal("planner" in (bodies[1] as object), false);
  assert.ok(!text.includes("secret"));
});
