// SPDX-License-Identifier: AGPL-3.0-or-later
// Writes engine/generated/radio.liq from environment variables (dev helper).
import { mkdirSync, writeFileSync } from "node:fs";
import { generateScript } from "../engine/liquidsoap.js";

const env = process.env;
const script = generateScript({
  icecastHost: env.ICECAST_HOST ?? "icecast",
  icecastPort: Number(env.ICECAST_PORT ?? 8000),
  icecastPassword: env.ICECAST_SOURCE_PASSWORD ?? "change-me",
  mount: env.ICECAST_MOUNT ?? "/radio",
  fallbackDir: "/media/fallback",
  telnetPort: 1234,
  harborPort: 8005,
  harborPassword: env.HARBOR_PASSWORD ?? "change-me-too",
  bitrateKbps: 128,
});
mkdirSync("engine/generated", { recursive: true });
writeFileSync("engine/generated/radio.liq", script);
console.log("wrote engine/generated/radio.liq");
