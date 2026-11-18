// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Asset } from "../library/library.js";

export interface PlayedEntry {
  assetId: number;
  artist: string;
  playedAt: Date;
}

export interface RotationRules {
  /** Minimum minutes before the same title may play again. */
  minTitleGapMin: number;
  /** Minimum minutes before the same artist may play again. */
  minArtistGapMin: number;
}

export const DEFAULT_RULES: RotationRules = { minTitleGapMin: 180, minArtistGapMin: 60 };

/**
 * Pick the next track. Respects title/artist separation, but NEVER returns null
 * while candidates exist: when every track is "too recent", it falls back to the
 * least recently played one. Dead air is worse than a repeat.
 * `rng` returns a number in [0, 1); inject a seeded one in tests.
 */
export function pickNext(
  candidates: Asset[],
  history: PlayedEntry[],
  now: Date,
  rules: RotationRules = DEFAULT_RULES,
  rng: () => number = Math.random,
): Asset | null {
  if (candidates.length === 0) return null;
  const minutesAgo = (d: Date) => (now.getTime() - d.getTime()) / 60000;
  const lastTitle = new Map<number, number>();
  const lastArtist = new Map<string, number>();
  for (const h of history) {
    const m = minutesAgo(h.playedAt);
    lastTitle.set(h.assetId, Math.min(lastTitle.get(h.assetId) ?? Infinity, m));
    const key = h.artist.toLowerCase();
    if (key) lastArtist.set(key, Math.min(lastArtist.get(key) ?? Infinity, m));
  }
  const ok = candidates.filter(
    (a) =>
      (lastTitle.get(a.id) ?? Infinity) >= rules.minTitleGapMin &&
      (a.artist ? (lastArtist.get(a.artist.toLowerCase()) ?? Infinity) >= rules.minArtistGapMin : true),
  );
  if (ok.length > 0) return ok[Math.min(ok.length - 1, Math.floor(rng() * ok.length))]!;
  // Nothing eligible: take the one played longest ago (never-played counts as oldest).
  return [...candidates].sort((a, b) => (lastTitle.get(b.id) ?? Infinity) - (lastTitle.get(a.id) ?? Infinity))[0]!;
}
