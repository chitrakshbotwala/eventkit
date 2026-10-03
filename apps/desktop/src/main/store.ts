import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/** Read JSON, returning `fallback` on any error (missing, corrupt). */
export function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Atomic JSON write (write temp + rename) so a crash never leaves a torn file. */
export function writeJson(file: string, value: unknown, opts: { mode?: number } = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: opts.mode });
  renameSync(tmp, file);
}
