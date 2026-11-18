// SPDX-License-Identifier: AGPL-3.0-or-later
// Engine selection from the environment (spec 001, section 2.10). Pure: no I/O, tested without
// starting the server. A wrong value is a configuration error (refuse to start), not an outage.
import net from "node:net";
import { pathProblem } from "./telnet.js";

export class ConfigError extends Error {}

export type EngineConfig =
  | { kind: "fake" }
  | { kind: "liquidsoap"; host: string; port: number; mediaRoot: string; engineMediaRoot: string; warnings: string[] };

/** True for 127.0.0.0/8, ::1, ::ffff:127.x and the name `localhost`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice(7) : h;
  if (net.isIPv4(v4)) return v4.startsWith("127.");
  if (net.isIPv6(h)) return /^(0{0,4}:){7}0{0,3}1$/.test(h) || h === "::1";
  return false;
}

export function readEngineConfig(env: Record<string, string | undefined>): EngineConfig {
  const kind = env.PIMSRADIO_ENGINE ?? "fake";
  if (kind === "fake") return { kind: "fake" };
  if (kind !== "liquidsoap") throw new ConfigError(`PIMSRADIO_ENGINE must be "fake" or "liquidsoap" (got ${JSON.stringify(kind.slice(0, 40))})`);

  const host = env.PIMSRADIO_LS_HOST ?? "127.0.0.1";
  if (host === "" || host.length > 253 || !/^[A-Za-z0-9._:-]+$/.test(host)) {
    throw new ConfigError("PIMSRADIO_LS_HOST must be a host name or an IP address");
  }
  const portText = env.PIMSRADIO_LS_PORT ?? "1234";
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError("PIMSRADIO_LS_PORT must be an integer between 1 and 65535");
  }
  const mediaRoot = env.PIMSRADIO_MEDIA_ROOT ?? "/media";
  const engineMediaRoot = env.PIMSRADIO_LS_MEDIA_ROOT ?? mediaRoot;
  for (const [name, v] of [["PIMSRADIO_MEDIA_ROOT", mediaRoot], ["PIMSRADIO_LS_MEDIA_ROOT", engineMediaRoot]] as const) {
    const problem = pathProblem(v);
    if (problem) throw new ConfigError(`${name} is not a usable absolute path: ${problem}`);
  }

  const warnings: string[] = [];
  if (!isLoopbackHost(host)) {
    const allow = env.PIMSRADIO_LS_ALLOW_REMOTE ?? "";
    if (allow !== "" && allow !== "0" && allow !== "1") throw new ConfigError("PIMSRADIO_LS_ALLOW_REMOTE must be 1 (or unset)");
    if (allow !== "1") {
      throw new ConfigError(
        `refusing to use the non-loopback Liquidsoap telnet host "${host}": the telnet server has no authentication. ` +
          "If it is on a trusted private network only (for instance the compose network), set PIMSRADIO_LS_ALLOW_REMOTE=1.",
      );
    }
    warnings.push("Liquidsoap telnet has no authentication: it must never cross an untrusted network");
  }
  return { kind: "liquidsoap", host, port, mediaRoot, engineMediaRoot, warnings };
}

export type HttpConfig = { host: string; warnings: string[] };

/**
 * Interface bind address (ADR 0006): 127.0.0.1 by default. A non-loopback host is refused unless
 * PIMSRADIO_ALLOW_REMOTE_UI=1. In Docker, keep the default-safe rule by setting PIMSRADIO_HOST=0.0.0.0
 * together with PIMSRADIO_ALLOW_REMOTE_UI=1 inside the container and publishing the port on
 * 127.0.0.1 in the compose file (for instance "127.0.0.1:8080:8080").
 */
export function readHttpConfig(env: Record<string, string | undefined>): HttpConfig {
  const host = env.PIMSRADIO_HOST ?? "127.0.0.1";
  if (host === "" || host.length > 253 || !/^[A-Za-z0-9._:-]+$/.test(host)) {
    throw new ConfigError("PIMSRADIO_HOST must be a host name or an IP address");
  }
  const warnings: string[] = [];
  if (!isLoopbackHost(host)) {
    const allow = env.PIMSRADIO_ALLOW_REMOTE_UI ?? "";
    if (allow !== "" && allow !== "0" && allow !== "1") throw new ConfigError("PIMSRADIO_ALLOW_REMOTE_UI must be 1 (or unset)");
    if (allow !== "1") {
      throw new ConfigError(
        `refusing to listen on the non-loopback address "${host}": the interface must not be exposed without protection. ` +
          "Set PIMSRADIO_ALLOW_REMOTE_UI=1 if a reverse proxy or a published-on-localhost port protects it (for instance in Docker).",
      );
    }
    warnings.push(`the interface listens on "${host}": make sure it is not reachable from an untrusted network`);
  }
  return { host, warnings };
}
