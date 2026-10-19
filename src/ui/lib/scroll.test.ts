import { describe, expect, it } from 'vitest';
import { NO_SCROLL, sameEdges, scrollEdges } from './scroll';

describe('scrollEdges', () => {
  it('reports no cue when the table fits', () => {
    expect(scrollEdges(0, 375, 375)).toEqual(NO_SCROLL);
    expect(scrollEdges(0, 375, 376)).toEqual(NO_SCROLL);
  });

  it('reports the hidden sides of a wide table', () => {
    // a 760 px table in a 343 px card (375 px screen)
    expect(scrollEdges(0, 343, 760)).toEqual({ overflow: true, left: false, right: true });
    expect(scrollEdges(200, 343, 760)).toEqual({ overflow: true, left: true, right: true });
    expect(scrollEdges(417, 343, 760)).toEqual({ overflow: true, left: true, right: false });
    // subpixel layout: scrolled to the end within a pixel
    expect(scrollEdges(416.4, 343, 760)).toEqual({ overflow: true, left: true, right: false });
  });

  it('compares edges by value', () => {
    expect(sameEdges(scrollEdges(0, 343, 760), { overflow: true, left: false, right: true })).toBe(true);
    expect(sameEdges(NO_SCROLL, scrollEdges(0, 343, 760))).toBe(false);
  });
});
