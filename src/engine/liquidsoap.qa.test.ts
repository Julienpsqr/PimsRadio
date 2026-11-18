// SPDX-License-Identifier: AGPL-3.0-or-later
// QA additions (spec 002, section 6: no unescaped value injected in the script).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateScript, lqString, type LiquidsoapConfig } from "./liquidsoap.js";

const cfg: LiquidsoapConfig = {
  icecastHost: "icecast", icecastPort: 8000, icecastPassword: "s3cret", mount: "/radio",
  fallbackDir: "/media/fallback", telnetPort: 1234, harborPort: 8005, harborPassword: "live", bitrateKbps: 128,
};

test("every string value of the config goes through lqString (hostile values stay inside quotes)", () => {
  const evil = 'x"); system("id"); y=("';
  const s = generateScript({ ...cfg, icecastHost: evil, icecastPassword: evil, harborPassword: evil, fallbackDir: evil, mount: "/" + evil });
  assert.ok(!s.includes(evil), "raw hostile value must not appear unescaped");
  assert.equal(s.split("system(").length - 1, 5, "only escaped occurrences");
  assert.ok(!/[^\\]"\); system\(/.test(s));
});

test("non-integer, negative and oversized numbers are rejected", () => {
  for (const bad of [1.5, -1, 65536, NaN, Infinity]) {
    assert.throws(() => generateScript({ ...cfg, harborPort: bad }));
    assert.throws(() => generateScript({ ...cfg, telnetPort: bad }));
    assert.throws(() => generateScript({ ...cfg, bitrateKbps: bad }));
  }
});

// BUG QA-1 (spec 002 report): Liquidsoap 2.x evaluates `#{...}` inside a double-quoted
// string, and lqString does not neutralise it (verified on v2.4.6: "a#{1+1}b" prints a2b).
// Marked todo so the suite stays green until the generator is fixed; remove `todo` then.
test("QA-1: '#{' interpolation in a value is neutralised", { todo: "bug QA-1: lqString does not escape #{" }, () => {
  const out = lqString("a#{1+1}b");
  assert.ok(!out.includes("#{"), out);
});
