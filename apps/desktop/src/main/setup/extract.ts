import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import extractZip from 'extract-zip';
import type { ArtifactKind, Platform } from '@eventkit/shared';
import { run } from './exec';

/**
 * Extract an archive into `dest` (created fresh). Uses OS tools that preserve
 * symlinks and permissions and are much faster than JS unzip for 1 GB SDKs:
 * Windows tar.exe (bsdtar, reads zip), macOS ditto, Linux unzip/tar.
 */
export async function extractArchive(
  archive: string,
  dest: string,
  kind: ArtifactKind,
  platform: Platform,
  opts: { signal?: AbortSignal; onLine?: (l: string) => void } = {},
): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const common = { signal: opts.signal, timeoutMs: 45 * 60_000 };

  if (kind === 'zip') {
    if (platform === 'windows') {
      const tar = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
      if (existsSync(tar)) {
        await run(tar, ['-xf', archive, '-C', dest], common);
        return;
      }
    } else if (platform === 'macos') {
      await run('/usr/bin/ditto', ['-x', '-k', archive, dest], common);
      return;
    } else if (existsSync('/usr/bin/unzip')) {
      await run('/usr/bin/unzip', ['-q', '-o', archive, '-d', dest], common);
      return;
    }
    await extractZip(archive, { dir: dest });
    return;
  }
  if (kind === 'tar.xz' || kind === 'tar.gz') {
    const tar =
      platform === 'windows'
        ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar';
    await run(tar, [kind === 'tar.xz' ? '-xJf' : '-xzf', archive, '-C', dest], common);
    return;
  }
  throw new Error(`cannot extract ${kind} archives`);
}

/** Extract an untrusted zip (starter project) with zip-slip protection. */
export async function extractZipSafe(archive: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  // extract-zip rejects entries resolving outside `dir`.
  await extractZip(archive, { dir: dest });
}

/** If `dir` contains exactly one directory (typical archive layout), return it. */
export async function singleChild(dir: string): Promise<string> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter(
    (e) => !e.name.startsWith('.') && e.name !== '__MACOSX',
  );
  if (entries.length === 1 && entries[0]!.isDirectory()) return join(dir, entries[0]!.name);
  return dir;
}

/**
 * Atomically-ish replace `dest` with `src` (same volume): move the old copy
 * aside, move the new one in, then delete the old one. Half-installed
 * leftovers from interrupted runs are cleaned up the same way.
 */
export async function replaceDir(src: string, dest: string): Promise<void> {
  const old = `${dest}.old-${Date.now()}`;
  if (existsSync(dest)) await renameRetry(dest, old);
  try {
    await renameRetry(src, dest);
  } catch (err) {
    if (existsSync(old) && !existsSync(dest)) await renameRetry(old, dest);
    throw err;
  }
  await rm(old, { recursive: true, force: true }).catch(() => undefined);
}

/** Windows: antivirus / indexers briefly lock fresh files (EPERM/EBUSY); retry renames. */
export async function renameRetry(from: string, to: string, attempts = 20): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw err;
      await new Promise((r) => setTimeout(r, 250 * i));
    }
  }
}
