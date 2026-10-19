// Canonical JSON for signing announcements: object keys sorted recursively,
// no whitespace. Module-local (the ledger has its own copy).

export function canonicalJson(value: unknown): string {
  return encode(value, 0);
}

const MAX_DEPTH = 32;

function encode(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new Error('canonicalJson: value too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : encode(v, depth + 1))).join(',')}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k], depth + 1)}`).join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}
