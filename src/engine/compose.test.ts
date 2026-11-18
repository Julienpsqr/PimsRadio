// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// dist/engine/compose.test.js -> repository root
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const compose = readFileSync(join(root, "deploy", "docker-compose.dev.yml"), "utf8");
const lines = compose.split("\n").filter((l) => !l.trim().startsWith("#"));

test("every image is pinned to a precise tag, never latest or floating", () => {
  const images = lines.map((l) => /^\s*image:\s*(\S+)\s*$/.exec(l)?.[1]).filter((x): x is string => !!x);
  assert.ok(images.length >= 2, "expected icecast and liquidsoap images");
  for (const img of images) {
    const tag = img.split(":")[1];
    assert.ok(tag, `${img} has no tag`);
    assert.notEqual(tag, "latest");
    assert.match(tag, /^v?\d+\.\d+\.\d+$/, `${img} must use an exact version tag`);
  }
  assert.equal(new Set(images).size, images.length, "each image is referenced once");
});

test("published ports are bound to 127.0.0.1 only", () => {
  const ports = lines.filter((l) => /"[^"]*:\d+"/.test(l));
  assert.ok(ports.length >= 3, "icecast, harbor and telnet ports expected");
  for (const l of ports) assert.match(l, /"127\.0\.0\.1:/, l.trim());
});

test("telnet port is published (to localhost) and passwords are overridable", () => {
  assert.match(compose, /PIMS_TELNET_PORT:-1234\}:1234/);
  assert.match(compose, /ICECAST_SOURCE_PASSWORD: \$\{ICECAST_SOURCE_PASSWORD:-change-me\}/);
});
