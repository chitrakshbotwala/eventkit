/**
 * Whether an IPC sender's frame URL is our renderer. file:// pages must be our exact
 * index.html; dev-server pages must share its origin.
 */
export function sameRenderer(
  frameUrl: string,
  expectedUrl: string,
  caseInsensitive = process.platform === 'win32',
): boolean {
  let actual: URL;
  try {
    actual = new URL(frameUrl);
  } catch {
    return false;
  }
  const expected = new URL(expectedUrl);
  if (expected.protocol !== 'file:') return actual.origin === expected.origin;
  // Windows paths are case-insensitive; percent-encoding may differ too.
  const norm = (u: URL) => {
    const p = decodeURIComponent(u.pathname);
    return caseInsensitive ? p.toLowerCase() : p;
  };
  return (
    actual.protocol === 'file:' && actual.host === expected.host && norm(actual) === norm(expected)
  );
}
