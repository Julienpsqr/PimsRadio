// SPDX-License-Identifier: AGPL-3.0-or-later
import { createServer, type Server } from "node:http";
import type { AirEngine, AudioEngine, EngineDetail } from "../engine/engine.js";
import { type Grid, resolveSlot } from "../scheduler/grid.js";

export interface ApiDeps {
  engine: AudioEngine;
  grid: Grid;
  timeZone: string;
  version: string;
  now?: () => Date;
}

/** Minimal HTTP API. No dependency; JSON only. */
export function createApi(deps: ApiDeps): Server {
  const now = deps.now ?? (() => new Date());
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/health") {
        // The control plane being up does not mean the engine is; report both.
        let engine = false;
        try { engine = await deps.engine.healthy(); } catch { engine = false; }
        // Only fixed fields (an error code, never a raw message): safe to expose.
        let engineDetail: EngineDetail | undefined;
        try { engineDetail = (deps.engine as Partial<AirEngine>).detail?.(); } catch { engineDetail = undefined; }
        return send(200, { ok: true, version: deps.version, engine, ...(engineDetail ? { engineDetail } : {}) });
      }
      if (req.method === "GET" && url.pathname === "/api/now") {
        return send(200, { slot: resolveSlot(deps.grid.all(), now(), deps.timeZone) });
      }
      send(404, { error: "not_found" });
    } catch {
      send(500, { error: "internal_error" });
    }
  });
}
