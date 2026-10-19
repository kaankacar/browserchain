import { Keypair } from '@stellar/stellar-sdk/base';
import { describe, expect, it } from 'vitest';
import { IDENTICON_GRID, fnv1a, identicon } from './identicon';

const keys = Array.from({ length: 40 }, (_, i) => Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(i + 1)).publicKey());

describe('identicon', () => {
  it('is deterministic', () => {
    const a = identicon(keys[0]);
    const b = identicon(keys[0]);
    expect(a).toEqual(b);
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).not.toBe(fnv1a('hellp'));
  });

  it('is mirrored left to right', () => {
    for (const k of keys) {
      const { cells } = identicon(k);
      expect(cells).toHaveLength(IDENTICON_GRID * IDENTICON_GRID);
      for (let y = 0; y < IDENTICON_GRID; y++) {
        for (let x = 0; x < IDENTICON_GRID; x++) {
          expect(cells[y * IDENTICON_GRID + x]).toBe(cells[y * IDENTICON_GRID + (IDENTICON_GRID - 1 - x)]);
        }
      }
    }
  });

  it('never renders an empty icon', () => {
    for (const k of [...keys, '', 'x', 'GA']) {
      expect(identicon(k).cells.filter(Boolean).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('spreads keys over different patterns and hues', () => {
    const patterns = new Set(keys.map((k) => identicon(k).cells.map((c) => (c ? 1 : 0)).join('')));
    const hues = new Set(keys.map((k) => Math.floor(identicon(k).hue / 30)));
    expect(patterns.size).toBeGreaterThan(30);
    expect(hues.size).toBeGreaterThan(6);
    for (const k of keys) {
      const { hue, fg, bg } = identicon(k);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(fg).toMatch(/^hsl\(/);
      expect(bg).toMatch(/^hsl\(/);
    }
  });
});
