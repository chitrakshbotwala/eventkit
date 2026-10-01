import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const TEST_DB = resolve(__dirname, '../prisma/test.db');

export default function setup() {
  rmSync(TEST_DB, { force: true });
  const prismaBin = resolve(__dirname, '../node_modules/.bin/prisma');
  // The file was just deleted, so this creates a fresh database (no reset flags needed).
  execFileSync(prismaBin, ['db', 'push', '--skip-generate'], {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: `file:${TEST_DB.replace(/\\/g, '/')}` },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
}
