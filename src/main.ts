// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "./api/server.js";
import { openDb } from "./db/db.js";
import { type AirEngine, FakeEngine } from "./engine/engine.js";
import { ConfigError, readEngineConfig, readHttpConfig, readPlannerConfig } from "./engine/config.js";
import { LiquidsoapEngine } from "./engine/liquidsoap-engine.js";
import { Grid } from "./scheduler/grid.js";
import { Library } from "./library/library.js";
import { PlannerLoop } from "./scheduler/loop.js";
import { Planner } from "./scheduler/planner.js";

const dataDir = process.env.PIMSRADIO_DATA ?? "./data";
const port = Number(process.env.PORT ?? 8080);
const timeZone = process.env.PIMSRADIO_TZ ?? "Europe/Paris";

let engineConfig;
let httpConfig;
let plannerConfig;
try {
  httpConfig = readHttpConfig(process.env);
  engineConfig = readEngineConfig(process.env);
  plannerConfig = readPlannerConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`Configuration error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

for (const w of httpConfig.warnings) console.warn(`WARNING: ${w}`);
mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "pimsradio.db"));
const library = new Library(db);

let engine: AirEngine;
let closeEngine: () => Promise<void> = async () => {};
if (engineConfig.kind === "liquidsoap") {
  for (const w of engineConfig.warnings) console.warn(`WARNING: ${w}`);
  const live = new LiquidsoapEngine({
    host: engineConfig.host, port: engineConfig.port,
    mediaRoot: engineConfig.mediaRoot, engineMediaRoot: engineConfig.engineMediaRoot,
    resolve: (p) => library.findByPath(p),
    log: (level, msg) => (level === "warn" ? console.warn : console.log)(`[engine] ${msg}`),
  });
  live.start(); // background: startup never depends on the engine being up
  closeEngine = () => live.close();
  engine = live;
} else {
  engine = new FakeEngine();
}

const grid = new Grid(db);
// Planner loop (spec 022): runs in the background; an engine or planner failure never stops the
// interface, and the audio never depends on it (ADR 0001).
const planner = new Planner(db, grid, library, engine, { timeZone, targetAheadS: plannerConfig.aheadS });
const loop = new PlannerLoop({
  tick: (now) => planner.tick(now),
  intervalMs: plannerConfig.intervalS * 1000,
  log: (level, msg) => (level === "warn" ? console.warn : console.log)(`[planner] ${msg}`),
});
loop.start();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    loop.stop()
      .then(() => closeEngine())
      .catch((e: unknown) => console.error(`[shutdown] failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => process.exit(0));
  });
}

createApi({ engine, grid, timeZone, version: "0.0.1", planner: () => loop.status() }).listen(port, httpConfig.host, () => {
  console.log(`PimsRadio listening on ${httpConfig.host}:${port}`);
});
