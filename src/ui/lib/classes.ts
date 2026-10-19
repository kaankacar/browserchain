// Class-name helpers for Tailwind utilities.

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// Utility groups where a caller's class must replace the base class (no variants).
const OVERRIDE_GROUPS = [/^w-/, /^h-/, /^min-h-/, /^text-(xs|sm|base|lg|xl|2xl|\[)/, /^p-/, /^px-/, /^pl-/, /^pr-/, /^py-/];

/**
 * Join base classes with caller classes. A caller's width, height, font size
 * or padding class replaces the base one of the same group, because Tailwind
 * does not let the later class in the attribute win.
 */
export function withOverrides(base: string, extra?: string | false | null): string {
  if (!extra) return base;
  const ex = extra.split(/\s+/).filter(Boolean);
  const plain = ex.filter((e) => !e.includes(':'));
  const keep = base
    .split(/\s+/)
    .filter(Boolean)
    .filter((b) => b.includes(':') || !OVERRIDE_GROUPS.some((g) => g.test(b) && plain.some((e) => g.test(e))));
  return [...keep, ...ex].join(' ');
}
