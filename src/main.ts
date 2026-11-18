// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "./api/server.js";
import { openDb } from "./db/db.js";
import { type AirEngine, FakeEngine } from "./engine/engine.js";
import { ConfigError, readEngineConfig } from "./engine/config.js";
import { LiquidsoapEngine } from "./engine/liquidsoap-engine.js";
import { Grid } from "./scheduler/grid.js";
import { Library } from "./library/library.js";

const dataDir = process.env.PIMSRADIO_DATA ?? "./data";
const port = Number(process.env.PORT ?? 8080);
const timeZone = process.env.PIMSRADIO_TZ ?? "Europe/Paris";

let engineConfig;
try {
  engineConfig = readEngineConfig(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`Configuration error: ${e.message}`);
    process.exit(1);
  }
  throw e;
}

mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "pimsradio.db"));
const library = new Library(db);

let engine: AirEngine;
if (engineConfig.kind === "liquidsoap") {
  for (const w of engineConfig.warnings) console.warn(`WARNING: ${w}`);
  const live = new LiquidsoapEngine({
    host: engineConfig.host, port: engineConfig.port,
    mediaRoot: engineConfig.mediaRoot, engineMediaRoot: engineConfig.engineMediaRoot,
    resolve: (p) => library.findByPath(p),
    log: (level, msg) => (level === "warn" ? console.warn : console.log)(`[engine] ${msg}`),
  });
  live.start(); // background: startup never depends on the engine being up
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => void live.close().finally(() => process.exit(0)));
  }
  engine = live;
} else {
  engine = new FakeEngine();
}
// The planner loop (a timer calling Planner.tick) is not wired here yet (out of scope of item 001).
createApi({ engine, grid: new Grid(db), timeZone, version: "0.0.1" }).listen(port, () => {
  console.log(`PimsRadio listening on :${port}`);
});
