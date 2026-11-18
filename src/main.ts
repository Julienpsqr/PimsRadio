// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createApi } from "./api/server.js";
import { openDb } from "./db/db.js";
import { FakeEngine } from "./engine/engine.js";
import { Grid } from "./scheduler/grid.js";

const dataDir = process.env.PIMSRADIO_DATA ?? "./data";
const port = Number(process.env.PORT ?? 8080);
const timeZone = process.env.PIMSRADIO_TZ ?? "Europe/Paris";

mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, "pimsradio.db"));
// TODO(phase 1): replace FakeEngine with the Liquidsoap engine.
createApi({ engine: new FakeEngine(), grid: new Grid(db), timeZone, version: "0.0.1" }).listen(port, () => {
  console.log(`PimsRadio listening on :${port}`);
});
