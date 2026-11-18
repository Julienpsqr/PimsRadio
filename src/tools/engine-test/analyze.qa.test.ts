// SPDX-License-Identifier: AGPL-3.0-or-later
// QA additions (spec 002, criterion 16): mutation-driven gaps in analyze.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, countDominant, dominantIndex, longestSilence, SILENCE_DB, type Pcm } from "./analyze.js";

const RATE = 8000;
const FREQS = [440, 880, 1320];
function tone(freq: number, seconds: number, amp = 0.5): Float64Array {
  const out = new Float64Array(Math.round(seconds * RATE));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / RATE);
  return out;
}
function concat(...parts: Float64Array[]): Pcm {
  const samples = new Float64Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { samples.set(p, o); o += p.length; }
  return { sampleRate: RATE, samples };
}

test("longestSilence resets after sound: two separate gaps are not added together", () => {
  const ws = analyze(concat(new Float64Array(RATE), tone(440, 1), new Float64Array(RATE), tone(440, 1), new Float64Array(RATE)), FREQS);
  assert.equal(longestSilence(ws), 1);
});

test("a wrong source is never reported as the expected one (880 Hz is not 440 Hz, 1320 is not 880)", () => {
  const ws = analyze(concat(tone(880, 2), tone(1320, 2)), FREQS);
  assert.deepEqual(countDominant(ws, 0, 0, 4), { hits: 0, total: 8 });
  assert.deepEqual(countDominant(ws, 1, 0, 2), { hits: 4, total: 4 });
  assert.deepEqual(countDominant(ws, 1, 2, 4), { hits: 0, total: 4 });
  assert.deepEqual(countDominant(ws, 2, 2, 4), { hits: 4, total: 4 });
});

test("the silence threshold is -50 dBFS: -45 dBFS is audible, -55 dBFS is silent", () => {
  assert.equal(SILENCE_DB, -50);
  const amp = (db: number) => 10 ** (db / 20) * Math.SQRT2;
  assert.equal(longestSilence(analyze(concat(tone(440, 1, amp(-45))), FREQS)), 0);
  assert.equal(longestSilence(analyze(concat(tone(440, 1, amp(-55))), FREQS)), 1);
});

test("dominance needs a 10x margin: 8x is ambiguous, 12x is dominant", () => {
  assert.equal(dominantIndex([8, 1, 0]), -1);
  assert.equal(dominantIndex([12, 1, 0]), 0);
});

test("a signal shorter than one window yields no window (no false OK)", () => {
  assert.deepEqual(analyze(concat(tone(440, 0.2)), FREQS), []);
  assert.deepEqual(countDominant([], 0, 0, 10), { hits: 0, total: 0 });
});

test("a tone off the analysed frequencies (500 Hz, 600 Hz) is not declared dominant 440", () => {
  for (const f of [500, 600, 700]) {
    const ws = analyze(concat(tone(f, 2)), FREQS);
    assert.deepEqual(countDominant(ws, 0, 0, 2), { hits: 0, total: 4 }, `${f} Hz`);
  }
  // sanity: the exact and a very close frequency still count
  assert.deepEqual(countDominant(analyze(concat(tone(440, 2)), FREQS), 0, 0, 2), { hits: 4, total: 4 });
  assert.deepEqual(countDominant(analyze(concat(tone(441, 2)), FREQS), 0, 0, 2), { hits: 4, total: 4 });
});
