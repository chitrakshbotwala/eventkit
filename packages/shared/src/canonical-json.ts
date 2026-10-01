/**
 * Deterministic JSON serialization used for anything that is signed or hashed
 * (manifests, readiness reports, connectivity log entries).
 *
 * Rules: object keys sorted by UTF-16 code unit order, no whitespace,
 * `undefined` object members are dropped (like JSON.stringify), arrays keep
 * order, non-finite numbers are rejected.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : serialize(v))).join(',')}]`;
      }
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
