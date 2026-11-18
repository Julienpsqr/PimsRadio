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
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true, version: "t", engine: true });
  engine.up = false;
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true, version: "t", engine: false });
  close();
});

test("now returns the slot on air; unknown routes give 404", async () => {
  const { base, close } = await start();
  const now = (await (await fetch(`${base}/api/now`)).json()) as { slot: { kind: string } };
  assert.equal(now.slot.kind, "rotation");
  assert.equal((await fetch(`${base}/api/nothing`)).status, 404);
  close();
});
