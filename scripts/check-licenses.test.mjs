// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, collect } from "./check-licenses.mjs";

test("licences simples autorisees", () => {
  for (const l of ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause", "LGPL-3.0-or-later", "AGPL-3.0-only"]) {
    assert.equal(isAllowed(l), true, l);
  }
});

test("licences interdites ou inconnues", () => {
  for (const l of ["GPL-2.0-only", "UNLICENSED", "Proprietary", "CC-BY-NC-4.0", "", undefined, "SEE LICENSE IN x"]) {
    assert.equal(isAllowed(l), false, String(l));
  }
});

test("expressions SPDX OR / AND", () => {
  assert.equal(isAllowed("MIT OR Apache-2.0"), true);
  assert.equal(isAllowed("(GPL-2.0-only OR MIT)"), true);
  assert.equal(isAllowed("GPL-2.0-only OR UNLICENSED"), false);
  assert.equal(isAllowed("MIT AND ISC"), true);
  assert.equal(isAllowed("MIT AND GPL-2.0-only"), false);
});

test("collect : lockfile, repli sur le manifeste, licence absente refusee", () => {
  const lock = { packages: {
    "": { name: "root" },
    "node_modules/a": { version: "1.0.0", license: "MIT" },
    "node_modules/b/node_modules/c": { version: "2.0.0" },
    "node_modules/d": { version: "3.0.0" },
  } };
  const rows = collect(lock, (p) => (p.endsWith("/c") ? "ISC" : undefined));
  assert.deepEqual(rows.map((r) => [r.name, r.ok]), [["a", true], ["c", true], ["d", false]]);
  assert.equal(rows[2].license, "(absente)");
});
