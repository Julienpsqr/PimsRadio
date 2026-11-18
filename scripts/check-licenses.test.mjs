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

test("parentheses : une licence interdite ne passe pas (fail-closed)", () => {
  assert.equal(isAllowed("GPL-2.0-only AND (MIT OR ISC)"), false);
  assert.equal(isAllowed("(MIT OR GPL-2.0-only) AND GPL-2.0-only"), false);
  assert.equal(isAllowed("(MIT OR GPL-2.0-only) AND ISC"), true);
  assert.equal(isAllowed("((MIT))"), true);
});

test("precedence : AND avant OR", () => {
  assert.equal(isAllowed("MIT OR GPL-2.0-only AND GPL-2.0-only"), true);
  assert.equal(isAllowed("GPL-2.0-only AND GPL-2.0-only OR MIT"), true);
  assert.equal(isAllowed("GPL-2.0-only OR MIT AND GPL-2.0-only"), false);
});

test("expressions mal formees refusees", () => {
  for (const e of ["MIT OR", "AND", "OR", "OR MIT", "MIT AND", "MIT MIT", "(MIT", "MIT)", "()", "MIT OR OR ISC", "MIT WITH Classpath-exception-2.0", "mit"]) {
    assert.equal(isAllowed(e), false, e);
  }
});

test("collect : lockfile sans packages (v1 / tronque) leve une erreur", () => {
  assert.throws(() => collect({ lockfileVersion: 1, dependencies: {} }));
  assert.throws(() => collect({}));
  assert.throws(() => collect(null));
});

test("collect : liens ignores, workspaces nommes explicitement", () => {
  const lock = { packages: {
    "": {},
    "node_modules/ws": { resolved: "packages/ws", link: true },
    "packages/ws": { name: "ws-local", version: "1.0.0", license: "MIT" },
    "tools/x": { version: "1.0.0" },
  } };
  const rows = collect(lock);
  assert.deepEqual(rows.map((r) => [r.name, r.ok]), [["ws-local", true], ["tools/x", false]]);
});

test("collect : licence objet ou tableau refusee", () => {
  const lock = { packages: {
    "node_modules/o": { version: "1.0.0", license: { type: "MIT" } },
    "node_modules/t": { version: "1.0.0", license: ["MIT"] },
    "node_modules/m": { version: "1.0.0" },
  } };
  const rows = collect(lock, (p) => (p.endsWith("/m") ? { type: "MIT" } : undefined));
  assert.deepEqual(rows.map((r) => r.ok), [false, false, false]);
  assert.equal(rows[0].license, "(invalide)");
});
