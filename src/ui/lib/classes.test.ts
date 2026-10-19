import { describe, expect, it } from 'vitest';
import { cx, withOverrides } from './classes';

describe('class helpers', () => {
  it('joins truthy parts', () => {
    expect(cx('a', false, null, undefined, 'b')).toBe('a b');
  });
  it('lets caller sizes replace base sizes', () => {
    expect(withOverrides('w-full h-9 text-sm px-3 rounded-lg', 'w-28 text-xs')).toBe('h-9 px-3 rounded-lg w-28 text-xs');
    expect(withOverrides('h-9 text-[13px]', 'h-7')).toBe('text-[13px] h-7');
    expect(withOverrides('text-sm text-fg', 'text-xs')).toBe('text-fg text-xs');
    expect(withOverrides('p-4 flex', 'p-0')).toBe('flex p-0');
  });
  it('keeps variant classes and colors', () => {
    expect(withOverrides('w-full sm:w-64 placeholder:text-fg-3', 'w-auto')).toBe('sm:w-64 placeholder:text-fg-3 w-auto');
    expect(withOverrides('w-full', 'sm:w-20')).toBe('w-full sm:w-20');
    expect(withOverrides('a b', undefined)).toBe('a b');
  });
});
