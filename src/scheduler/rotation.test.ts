// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Asset } from "../library/library.js";
import { pickNext } from "./rotation.js";

const mk = (id: number, artist: string): Asset => ({
  id, kind: "music", path: `/m/${id}`, title: `T${id}`, artist, durationS: 200,
  language: null, loudnessLufs: null, tags: [],
});
const now = new Date("2026-07-01T12:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60000);

test("returns null only when there is no candidate", () => {
  assert.equal(pickNext([], [], now), null);
});

test("skips a title or an artist played too recently", () => {
  const pool = [mk(1, "A"), mk(2, "A"), mk(3, "B")];
  const hist = [{ assetId: 1, artist: "A", playedAt: ago(10) }];
  for (let i = 0; i < 20; i++) assert.equal(pickNext(pool, hist, now, undefined, Math.random)!.id, 3);
});

test("never goes silent: falls back to the least recently played", () => {
  const pool = [mk(1, "A"), mk(2, "B")];
  const hist = [
    { assetId: 1, artist: "A", playedAt: ago(5) },
    { assetId: 2, artist: "B", playedAt: ago(20) },
  ];
  assert.equal(pickNext(pool, hist, now)!.id, 2);
});

test("is deterministic with an injected rng", () => {
  const pool = [mk(1, "A"), mk(2, "B"), mk(3, "C")];
  assert.equal(pickNext(pool, [], now, undefined, () => 0)!.id, 1);
  assert.equal(pickNext(pool, [], now, undefined, () => 0.99)!.id, 3);
});
