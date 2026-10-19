import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { latin1, readUint32BE } from './bytes';

describe('latin1', () => {
  it('maps every byte to one char of the same code', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const s = latin1(all);
    expect(s).toHaveLength(256);
    for (let i = 0; i < 256; i++) expect(s.charCodeAt(i)).toBe(i);
    expect(latin1(new Uint8Array(0))).toBe('');
  });
});

describe('readUint32BE', () => {
  it('reads unsigned big-endian values and checks the range', () => {
    const b = Uint8Array.of(0xff, 0xff, 0xff, 0xfe, 0x01, 0x02, 0x03, 0x04);
    expect(readUint32BE(b)).toBe(0xfffffffe);
    expect(readUint32BE(b, 4)).toBe(0x01020304);
    expect(readUint32BE(b.subarray(4))).toBe(0x01020304);
    expect(() => readUint32BE(b, 5)).toThrow(/out of range/);
    expect(() => readUint32BE(b, -1)).toThrow(/out of range/);
  });
});

describe('no Buffer in app code', () => {
  it('src never uses the Node Buffer (browsers have none, and there is no polyfill)', () => {
    // Vitest runs in Node, where Buffer exists, and tsconfig includes the Node
    // types, so neither the tests nor tsc catch a Buffer that fails only in the browser.
    const src = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];
    for (const rel of readdirSync(src, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(rel) || /\.test\.ts$/.test(rel)) continue;
      readFileSync(`${src}/${rel}`, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (/(?<![\w$])Buffer(?![\w$])/.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
