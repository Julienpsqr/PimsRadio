// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfigError, isLoopbackHost, readEngineConfig } from "./config.js";

const ls = (env: Record<string, string>) => readEngineConfig({ PIMSRADIO_ENGINE: "liquidsoap", ...env });

test("25. no variable: the fake engine (demo)", () => {
  assert.deepEqual(readEngineConfig({}), { kind: "fake" });
  assert.deepEqual(readEngineConfig({ PIMSRADIO_ENGINE: "fake", PIMSRADIO_LS_PORT: "garbage" }), { kind: "fake" });
});

test("25. liquidsoap defaults", () => {
  assert.deepEqual(ls({}), {
    kind: "liquidsoap", host: "127.0.0.1", port: 1234, mediaRoot: "/media", engineMediaRoot: "/media", warnings: [],
  });
  const c = ls({ PIMSRADIO_MEDIA_ROOT: "/srv/media", PIMSRADIO_LS_PORT: "2000" });
  assert.deepEqual([c.kind === "liquidsoap" && c.engineMediaRoot, c.kind === "liquidsoap" && c.port], ["/srv/media", 2000]);
  const d = ls({ PIMSRADIO_MEDIA_ROOT: "/srv/media", PIMSRADIO_LS_MEDIA_ROOT: "/media" });
  assert.equal(d.kind === "liquidsoap" && d.mediaRoot, "/srv/media");
  assert.equal(d.kind === "liquidsoap" && d.engineMediaRoot, "/media");
});

test("25. invalid values refuse to start with a clear message", () => {
  const bad: Array<Record<string, string>> = [
    { PIMSRADIO_ENGINE: "liquidsoup" }, { PIMSRADIO_ENGINE: "" },
    { PIMSRADIO_LS_PORT: "abc" }, { PIMSRADIO_LS_PORT: "0" }, { PIMSRADIO_LS_PORT: "65536" }, { PIMSRADIO_LS_PORT: "12.5" },
    { PIMSRADIO_LS_PORT: "-1" }, { PIMSRADIO_LS_PORT: "" }, { PIMSRADIO_LS_PORT: "1e3" },
    { PIMSRADIO_LS_HOST: "" }, { PIMSRADIO_LS_HOST: "bad host" }, { PIMSRADIO_LS_HOST: "a\nb" },
    { PIMSRADIO_MEDIA_ROOT: "relative" }, { PIMSRADIO_LS_MEDIA_ROOT: "/a/../b" },
  ];
  for (const env of bad) {
    const isEngineVar = "PIMSRADIO_ENGINE" in env;
    assert.throws(() => (isEngineVar ? readEngineConfig(env) : ls(env)), (e: unknown) => e instanceof ConfigError && e.message.length > 20, JSON.stringify(env));
  }
});

test("25. a non-loopback host is refused unless PIMSRADIO_LS_ALLOW_REMOTE=1, then it is accepted with a warning", () => {
  assert.throws(() => ls({ PIMSRADIO_LS_HOST: "liquidsoap" }), /PIMSRADIO_LS_ALLOW_REMOTE=1/);
  assert.throws(() => ls({ PIMSRADIO_LS_HOST: "192.168.1.5", PIMSRADIO_LS_ALLOW_REMOTE: "0" }), ConfigError);
  assert.throws(() => ls({ PIMSRADIO_LS_HOST: "10.0.0.2", PIMSRADIO_LS_ALLOW_REMOTE: "yes" }), /must be 1/);
  const c = ls({ PIMSRADIO_LS_HOST: "liquidsoap", PIMSRADIO_LS_ALLOW_REMOTE: "1" });
  assert.equal(c.kind === "liquidsoap" && c.host, "liquidsoap");
  assert.match(c.kind === "liquidsoap" ? (c.warnings[0] ?? "") : "", /no authentication/);
  for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "::ffff:127.0.0.1"]) {
    const l = ls({ PIMSRADIO_LS_HOST: h });
    assert.deepEqual(l.kind === "liquidsoap" && l.warnings, [], h);
  }
});

test("loopback detection does not take look-alikes for loopback", () => {
  for (const h of ["127.0.0.1", "127.255.255.254", "LOCALHOST", "::1", "0:0:0:0:0:0:0:1"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["128.0.0.1", "1127.0.0.1", "localhost.example.org", "0.0.0.0", "::", "::2", "liquidsoap", "127.0.0.1.evil.org", "10.0.0.1"]) {
    assert.equal(isLoopbackHost(h), false, h);
  }
});
