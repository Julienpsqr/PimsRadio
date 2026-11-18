// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, countDominant, dominantIndex, goertzel, isSilent, longestSilence, parseWav, rmsDb, type Pcm } from "./analyze.js";

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
function wav(samples: Float64Array, opts: { channels?: number; sizeField?: number } = {}): Buffer {
  const ch = opts.channels ?? 1;
  const data = Buffer.alloc(samples.length * ch * 2);
  for (let i = 0; i < samples.length; i++)
    for (let c = 0; c < ch; c++) data.writeInt16LE(Math.round((samples[i] as number) * 32767), (i * ch + c) * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + data.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(ch, 22);
  head.writeUInt32LE(RATE, 24); head.writeUInt32LE(RATE * ch * 2, 28); head.writeUInt16LE(ch * 2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36); head.writeUInt32LE(opts.sizeField ?? data.length, 40);
  return Buffer.concat([head, data]);
}

test("silence is detected: -Infinity dB and below threshold", () => {
  const pcm = concat(new Float64Array(RATE * 2));
  const ws = analyze(pcm, FREQS);
  assert.equal(ws.length, 4);
  assert.ok(ws.every((w) => isSilent(w)));
  assert.equal(rmsDb(pcm.samples), -Infinity);
  assert.equal(longestSilence(ws), 2);
});

test("a very quiet signal (-60 dBFS) counts as silent, -20 dBFS does not", () => {
  assert.ok(isSilent(analyze(concat(tone(440, 0.5, 0.0014 * Math.SQRT2)), FREQS)[0]!));
  assert.ok(!isSilent(analyze(concat(tone(440, 0.5, 0.1 * Math.SQRT2)), FREQS)[0]!));
});

test("RMS of a full-scale-ish sine is about -3 dB for amplitude 1", () => {
  assert.ok(Math.abs(rmsDb(tone(440, 1, 1)) - -3.01) < 0.05);
});

test("each test tone is identified as dominant", () => {
  FREQS.forEach((f, idx) => {
    const w = analyze(concat(tone(f, 1)), FREQS);
    assert.ok(w.every((x) => dominantIndex(x.energies) === idx), `freq ${f}`);
  });
});

test("goertzel energy is ~amplitude^2 at the tone and ~0 elsewhere", () => {
  const s = tone(880, 0.5, 0.5);
  assert.ok(Math.abs(goertzel(s, RATE, 880) - 0.25) < 0.01);
  assert.ok(goertzel(s, RATE, 440) < 0.001);
  assert.equal(goertzel(new Float64Array(0), RATE, 440), 0);
});

test("a mix of two equal tones has no dominant frequency", () => {
  const a = tone(440, 0.5), b = tone(880, 0.5);
  const mix = a.map((v, i) => v + (b[i] as number));
  assert.equal(dominantIndex(analyze(concat(mix), FREQS)[0]!.energies), -1);
});

test("silence has no dominant frequency", () => {
  assert.equal(dominantIndex([0, 0, 0]), -1);
  assert.equal(dominantIndex([]), -1);
});

test("countDominant follows a source change and longestSilence finds the gap", () => {
  const pcm = concat(tone(440, 5), new Float64Array(RATE * 1.5), tone(880, 5));
  const ws = analyze(pcm, FREQS);
  assert.deepEqual(countDominant(ws, 0, 0, 5), { hits: 10, total: 10 });
  assert.deepEqual(countDominant(ws, 1, 6.5, 11.5), { hits: 10, total: 10 });
  assert.equal(countDominant(ws, 1, 0, 5).hits, 0);
  assert.equal(longestSilence(ws), 1.5);
  assert.equal(longestSilence(ws, 7), 0);
});

test("parseWav round-trips mono, averages stereo, tolerates streaming size fields", () => {
  const s = tone(440, 0.5);
  const mono = parseWav(wav(s));
  assert.equal(mono.sampleRate, RATE);
  assert.equal(mono.samples.length, s.length);
  assert.ok(Math.abs((mono.samples[10] as number) - (s[10] as number)) < 1e-3);
  assert.equal(parseWav(wav(s, { channels: 2 })).samples.length, s.length);
  assert.equal(parseWav(wav(s, { sizeField: 0 })).samples.length, s.length);
  assert.equal(parseWav(wav(s, { sizeField: 0xffffffff })).samples.length, s.length);
});

test("parseWav rejects garbage and unsupported formats", () => {
  assert.throws(() => parseWav(Buffer.from("hello")), /not a WAV/);
  const bad = wav(tone(440, 0.1));
  bad.writeUInt16LE(8, 34);
  assert.throws(() => parseWav(bad), /16-bit/);
  assert.throws(() => parseWav(wav(tone(440, 0.1)).subarray(0, 36)), /no data/);
});
