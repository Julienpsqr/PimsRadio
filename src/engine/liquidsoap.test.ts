// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateScript, lqString, type LiquidsoapConfig } from "./liquidsoap.js";

const cfg: LiquidsoapConfig = {
  icecastHost: "icecast", icecastPort: 8000, icecastPassword: "s3cret", mount: "/radio",
  fallbackDir: "/media/fallback", telnetPort: 1234, harborPort: 8005, harborPassword: "live", bitrateKbps: 128,
};

test("script contains the safety chain and the outputs", () => {
  const s = generateScript(cfg);
  assert.match(s, /fallback\(track_sensitive=false, \[live, queue, emergency\]\)/);
  assert.match(s, /mksafe/);
  assert.match(s, /output\.icecast/);
  assert.match(s, /mount="\/radio"/);
});

test("quotes and backslashes in values cannot break out of the string", () => {
  assert.equal(lqString('a"b\\c'), '"a\\"b\\\\c"');
  const s = generateScript({ ...cfg, icecastPassword: 'x"); system("rm -rf /' });
  assert.ok(s.includes('password="x\\"); system(\\"rm -rf /"'));
});

test("rejects control characters, bad ports and bad mounts", () => {
  assert.throws(() => lqString("a\nb"));
  assert.throws(() => generateScript({ ...cfg, icecastPort: 0 }));
  assert.throws(() => generateScript({ ...cfg, mount: "radio" }));
});

test("harbor input uses a short pre-buffer so live switching is fast", () => {
  assert.match(generateScript(cfg), /input\.harbor\("live", port=8005, password="live", buffer=2\., max=6\.\)/);
});
