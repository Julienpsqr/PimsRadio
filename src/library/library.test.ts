// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../db/db.js";
import { Library } from "./library.js";

test("add, get, list by kind and tag, remove", () => {
  const lib = new Library(openDb(":memory:"));
  const a = lib.add({ kind: "music", path: "/m/a.mp3", title: " Alpha ", artist: "X", durationS: 200, tags: ["fr"] });
  lib.add({ kind: "music", path: "/m/b.mp3", title: "Beta", durationS: 180 });
  lib.add({ kind: "jingle", path: "/j/1.mp3", title: "Jingle", durationS: 5 });
  assert.equal(a.title, "Alpha");
  assert.equal(lib.list("music").length, 2);
  assert.deepEqual(lib.list("music", "fr").map((x) => x.id), [a.id]);
  assert.equal(lib.remove(a.id), true);
  assert.equal(lib.get(a.id), null);
});

test("rejects empty title and duplicate path", () => {
  const lib = new Library(openDb(":memory:"));
  assert.throws(() => lib.add({ kind: "music", path: "/x", title: "  ", durationS: 1 }));
  lib.add({ kind: "music", path: "/x", title: "T", durationS: 1 });
  assert.throws(() => lib.add({ kind: "music", path: "/x", title: "U", durationS: 1 }));
});
