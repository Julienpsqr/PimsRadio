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

test("the script registers the read-only pims.state command (spec 001)", () => {
  const s = generateScript(cfg);
  assert.match(s, /server\.register\(namespace="pims", description="[^"]*", usage="state", "state", pims_state\)/);
  for (const key of ["source=", "rid=", "uptime=", "filename="]) assert.ok(s.includes(key), key);
  assert.match(s, /live\.is_ready\(\)/);
  assert.match(s, /queue\.is_ready\(\)/);
  assert.match(s, /fallback_playlist = playlist\(/);
  // No telnet-reachable command that could stop or reconfigure the engine is registered here.
  assert.ok(!/server\.register\([^)]*(shutdown|restart|exit)/i.test(s));
});

test("the state command does not change with hostile config values and stays before the output", () => {
  const s = generateScript({ ...cfg, fallbackDir: '/media/x"#{system("id")}' });
  assert.ok(s.indexOf("pims_state") < s.indexOf("output.icecast"));
  assert.ok(!s.includes('"#{system'), "interpolation stays escaped");
});
