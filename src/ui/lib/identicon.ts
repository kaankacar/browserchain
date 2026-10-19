// Deterministic 5x5 mirrored identicon from a key (node id, account id).

import { seededRng } from '../../lib/random';

export const IDENTICON_GRID = 5;

export interface Identicon {
  /** Hue in degrees, 0..359. */
  hue: number;
  /** Row-major 5x5 cells; true = filled. Mirrored left/right. */
  cells: boolean[];
  fg: string;
  bg: string;
}

/** FNV-1a 32-bit over UTF-16 code units. Stable and fast; not cryptographic. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const cache = new Map<string, Identicon>();

export function identicon(key: string): Identicon {
  const hit = cache.get(key);
  if (hit) return hit;
  const rng = seededRng(fnv1a(key || '?'));
  const hue = Math.floor(rng() * 360);
  const cells: boolean[] = new Array(IDENTICON_GRID * IDENTICON_GRID).fill(false);
  const half = Math.ceil(IDENTICON_GRID / 2);
  let filled = 0;
  for (let y = 0; y < IDENTICON_GRID; y++) {
    for (let x = 0; x < half; x++) {
      const on = rng() < 0.5;
      if (!on) continue;
      cells[y * IDENTICON_GRID + x] = true;
      cells[y * IDENTICON_GRID + (IDENTICON_GRID - 1 - x)] = true;
      filled++;
    }
  }
  // Avoid empty or nearly empty icons: force the center column on.
  if (filled < 3) {
    for (let y = 0; y < IDENTICON_GRID; y++) cells[y * IDENTICON_GRID + Math.floor(IDENTICON_GRID / 2)] = true;
  }
  const sat = 55 + Math.floor(rng() * 20);
  const icon: Identicon = {
    hue,
    cells,
    fg: `hsl(${hue} ${sat}% 62%)`,
    bg: `hsl(${hue} 30% 16%)`,
  };
  if (cache.size > 2000) cache.clear();
  cache.set(key, icon);
  return icon;
}
