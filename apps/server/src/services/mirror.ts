import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function mirrorRoot(dataDir: string) {
  return resolve(dataDir, 'mirror');
}

/** Resolve a mirror-relative path, refusing anything that escapes the mirror root. */
export function mirrorFile(dataDir: string, relPath: string): string {
  const root = mirrorRoot(dataDir);
  const full = resolve(root, relPath);
  if (!full.startsWith(root + sep)) throw new Error(`invalid mirror path: ${relPath}`);
  return full;
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  await pipeline(
    createReadStream(path),
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        h.update(chunk);
        size += chunk.length;
        cb();
      },
    }),
  );
  return { sha256: h.digest('hex'), size };
}

/**
 * Download `url` into the mirror at `relPath` (unless already cached) and return
 * its SHA-256. A `.sha256` sidecar caches the hash.
 */
export async function ensureMirrored(
  dataDir: string,
  url: string,
  relPath: string,
  opts: { expectedSha256?: string; fetchImpl?: typeof fetch; log?: (m: string) => void } = {},
): Promise<{ sha256: string; size: number; path: string }> {
  const path = mirrorFile(dataDir, relPath);
  const sidecar = `${path}.sha256`;
  try {
    const st = await stat(path);
    const cached = (await readFile(sidecar, 'utf8').catch(() => '')).trim();
    if (cached && (!opts.expectedSha256 || cached === opts.expectedSha256)) {
      return { sha256: cached, size: st.size, path };
    }
  } catch {
    // not cached yet
  }

  opts.log?.(`downloading ${url}`);
  await mkdir(dirname(path), { recursive: true });
  const res = await (opts.fetchImpl ?? fetch)(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`GET ${url} -> ${res.status}`);
  const tmp = `${path}.part`;
  const h = createHash('sha256');
  let size = 0;
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    new Transform({
      transform(chunk: Buffer, _enc, cb) {
        h.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    }),
    createWriteStream(tmp),
  );
  const sha256 = h.digest('hex');
  if (opts.expectedSha256 && opts.expectedSha256 !== sha256) {
    await rm(tmp, { force: true });
    throw new Error(`sha256 mismatch for ${url}: expected ${opts.expectedSha256}, got ${sha256}`);
  }
  await rename(tmp, path);
  await writeFile(sidecar, sha256);
  return { sha256, size, path };
}

export async function verifyMirrored(dataDir: string, relPath: string, sha256: string) {
  const path = mirrorFile(dataDir, relPath);
  const r = await hashFile(path);
  return r.sha256 === sha256;
}
