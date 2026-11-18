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

// QA-1: Liquidsoap 2.x evaluates `#{...}` inside a double-quoted string (verified on v2.4.6:
// "a#{1+1}b" prints a2b). lqString writes the brace as the escape \x7b, which yields a literal
// `{` (also checked by `npm run test:engine`, criterion 1, by really executing the script).
test("QA-1: '#{' interpolation in a value is neutralised", () => {
  const out = lqString("a#{1+1}b");
  assert.ok(!out.includes("#{"), out);
  assert.equal(out, '"a#\\x7b1+1}b"');
});

test("QA-1: hostile interpolation in every config value never leaves a '#{' in the script", () => {
  const evil = '#{system("touch /tmp/x")}';
  const s = generateScript({ ...cfg, icecastHost: evil, icecastPassword: evil, harborPassword: evil, fallbackDir: evil, mount: "/" + evil });
  assert.ok(!s.includes("#{"));
});

test("QA-1: backslash before the brace does not rebuild an interpolation", () => {
  for (const v of ["#\\{x}", "##{x}", "\\#{x}", "#{#{x}}"]) {
    const out = lqString(v);
    assert.ok(!out.includes("#{"), out);
  }
});
