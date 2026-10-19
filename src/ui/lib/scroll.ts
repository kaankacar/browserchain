// Scroll cue for wide tables: which sides of a horizontal scroller hide
// content (docs/ARCHITECTURE.md 14: the UI works at 375 px).

export interface ScrollEdges {
  /** The content is wider than the box, so the box scrolls sideways. */
  overflow: boolean;
  /** Content is hidden to the left (the user scrolled). */
  left: boolean;
  /** Content is hidden to the right. */
  right: boolean;
}

export const NO_SCROLL: ScrollEdges = { overflow: false, left: false, right: false };

/**
 * Hidden sides of a scroller from its scrollLeft, clientWidth and
 * scrollWidth. 1 px of slack absorbs subpixel layout.
 */
export function scrollEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): ScrollEdges {
  const max = scrollWidth - clientWidth;
  if (max <= 1) return NO_SCROLL;
  return { overflow: true, left: scrollLeft > 1, right: scrollLeft < max - 1 };
}

export function sameEdges(a: ScrollEdges, b: ScrollEdges): boolean {
  return a.overflow === b.overflow && a.left === b.left && a.right === b.right;
}
