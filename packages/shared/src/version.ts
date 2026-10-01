/**
 * Loose numeric version comparison for tool versions such as
 * "3.24.3", "2.47.1.windows.2", "17.0.12+7", "1.95.0".
 * Only the leading dotted numeric part is compared.
 */
export function parseVersion(v: string): number[] {
  const m = /\d+(?:\.\d+)*/.exec(v);
  if (!m) return [];
  return m[0].split('.').map((p) => Number.parseInt(p, 10));
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function satisfiesMin(version: string | undefined | null, min: string | undefined | null) {
  if (!min) return true;
  if (!version) return false;
  return compareVersions(version, min) >= 0;
}

/** Major component of a version, e.g. 17 for "17.0.12+7". */
export function majorOf(v: string): number | undefined {
  return parseVersion(v)[0];
}
