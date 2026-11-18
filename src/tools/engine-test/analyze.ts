// SPDX-License-Identifier: AGPL-3.0-or-later
// Dependency-free audio analysis for the engine test: WAV parsing, RMS per
// window, Goertzel tone energy, dominant tone, silence runs.

export interface Pcm {
  sampleRate: number;
  samples: Float64Array;
}

export interface Window {
  /** Start of the window, in seconds from the start of the signal. */
  start: number;
  rmsDb: number;
  /** Goertzel power for each analysed frequency (same order as `freqs`). */
  energies: number[];
}

export const SILENCE_DB = -50;
export const DOMINANCE_RATIO = 10;

/** Parse a RIFF/WAVE file (16-bit PCM). Multi-channel is averaged to mono. */
export function parseWav(buf: Buffer): Pcm {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV file");
  }
  let pos = 12;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("ascii", pos, pos + 4);
    const declared = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === "fmt ") {
      if (body + 16 > buf.length) throw new Error("truncated WAV fmt chunk");
      const format = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
      if ((format !== 1 && format !== 0xfffe) || bits !== 16) throw new Error("only 16-bit PCM WAV is supported");
    } else if (id === "data") {
      if (channels < 1 || sampleRate < 1) throw new Error("WAV data chunk before fmt chunk");
      // Streaming writers leave the size at 0 or 0xFFFFFFFF: read to end of file.
      const available = buf.length - body;
      const size = declared === 0 || declared > available ? available : declared;
      const frames = Math.floor(size / (2 * channels));
      const samples = new Float64Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += buf.readInt16LE(body + (i * channels + c) * 2);
        samples[i] = sum / channels / 32768;
      }
      return { sampleRate, samples };
    }
    pos = body + declared + (declared % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** Goertzel algorithm: power of the signal at `freq` Hz, normalised by length. */
export function goertzel(samples: ArrayLike<number>, sampleRate: number, freq: number): number {
  const n = samples.length;
  if (n === 0) return 0;
  const w = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = (samples[i] as number) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (4 * power) / (n * n);
}

export function rmsDb(samples: ArrayLike<number>): number {
  if (samples.length === 0) return -Infinity;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += (samples[i] as number) ** 2;
  const rms = Math.sqrt(sum / samples.length);
  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

/** Split a signal into fixed windows (the trailing partial window is dropped). */
export function analyze(pcm: Pcm, freqs: readonly number[], windowSec = 0.5): Window[] {
  const size = Math.round(pcm.sampleRate * windowSec);
  if (size < 1) throw new Error("window too small");
  const out: Window[] = [];
  for (let i = 0; i + size <= pcm.samples.length; i += size) {
    const slice = pcm.samples.subarray(i, i + size);
    out.push({
      start: i / pcm.sampleRate,
      rmsDb: rmsDb(slice),
      energies: freqs.map((f) => goertzel(slice, pcm.sampleRate, f)),
    });
  }
  return out;
}

export function isSilent(w: Window, thresholdDb = SILENCE_DB): boolean {
  return w.rmsDb < thresholdDb;
}

/** Index of the dominant frequency (energy >= ratio x every other), or -1. */
export function dominantIndex(energies: readonly number[], ratio = DOMINANCE_RATIO): number {
  let best = -1;
  for (let i = 0; i < energies.length; i++) {
    if (best === -1 || (energies[i] as number) > (energies[best] as number)) best = i;
  }
  if (best === -1 || (energies[best] as number) <= 0) return -1;
  for (let i = 0; i < energies.length; i++) {
    if (i !== best && (energies[best] as number) < ratio * (energies[i] as number)) return -1;
  }
  return best;
}

export function windowsBetween(ws: readonly Window[], from: number, to: number): Window[] {
  return ws.filter((w) => w.start >= from && w.start + 0.5 <= to + 1e-9);
}

/** Number of windows in [from, to] whose dominant tone is `freqs[idx]`, and the total. */
export function countDominant(ws: readonly Window[], idx: number, from: number, to: number): { hits: number; total: number } {
  const sel = windowsBetween(ws, from, to);
  return { hits: sel.filter((w) => dominantIndex(w.energies) === idx).length, total: sel.length };
}

/** Longest run of consecutive silent windows at or after `from`, in seconds. */
export function longestSilence(ws: readonly Window[], from = 0, windowSec = 0.5, thresholdDb = SILENCE_DB): number {
  let longest = 0;
  let run = 0;
  for (const w of ws) {
    if (w.start < from) continue;
    run = isSilent(w, thresholdDb) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest * windowSec;
}
