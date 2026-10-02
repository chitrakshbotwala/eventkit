#!/usr/bin/env node
// `pnpm dev`: server + admin + desktop together with prefixed output.
// `pnpm dev:simulate` (or `pnpm dev -- --simulate`) runs the desktop app in simulate mode.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const simulate = process.argv.includes('--simulate');
const only = process.argv
  .find((a) => a.startsWith('--only='))
  ?.slice(7)
  .split(',');

if (!existsSync(resolve(root, 'apps/server/.env'))) {
  console.error('apps/server/.env missing: run `pnpm bootstrap` first.');
  process.exit(1);
}

const apps = [
  { name: 'server', color: 36, args: ['--filter', '@eventkit/server', 'dev'] },
  { name: 'admin', color: 35, args: ['--filter', '@eventkit/admin', 'dev'] },
  {
    name: 'desktop',
    color: 33,
    args: ['--filter', '@eventkit/desktop', 'dev', ...(simulate ? ['--', '--simulate'] : [])],
    delayMs: 2500,
  },
].filter((a) => !only || only.includes(a.name));

const children = [];
for (const a of apps) {
  setTimeout(() => {
    // pnpm is a .cmd shim on Windows, which requires a shell; all arguments are constants.
    const child = spawn('pnpm', a.args, {
      cwd: root,
      shell: process.platform === 'win32',
      env: process.env,
    });
    children.push(child);
    const prefix = `\u001b[${a.color}m[${a.name}]\u001b[0m `;
    const pipe = (stream, out) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const l of lines) out.write(prefix + l + '\n');
      });
    };
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on('exit', (code) => {
      console.log(`${prefix}exited with ${code}`);
      if (a.name === 'server') shutdown(code ?? 1);
    });
  }, a.delayMs ?? 0);
}

function shutdown(code = 0) {
  for (const c of children) if (!c.killed) c.kill();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
