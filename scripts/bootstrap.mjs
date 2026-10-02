#!/usr/bin/env node
// One-shot dev setup: env files + keys, database schema, seed data.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

for (const app of ['server', 'desktop', 'admin']) {
  const env = resolve(root, `apps/${app}/.env`);
  const example = resolve(root, `apps/${app}/.env.example`);
  if (!existsSync(env) && existsSync(example)) copyFileSync(example, env);
}
run('node', ['scripts/gen-keys.mjs']);
run('pnpm', ['--filter', '@eventkit/server', 'exec', 'prisma', 'db', 'push', '--skip-generate']);
run('pnpm', ['--filter', '@eventkit/server', 'run', 'db:seed']);
console.log('\nSetup complete. Run `pnpm dev` (or `pnpm dev:simulate`).');
