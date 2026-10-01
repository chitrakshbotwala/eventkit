import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLine } from '../common/ipc';

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;
const RING = 2000;

/** Patterns that must never reach log files (tokens, keys, codes). */
const REDACTIONS: Array<[RegExp, string]> = [
  [/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[redacted]'],
  [
    /("?(?:token|deviceKey|qrSecret|secret|password|code)"?\s*[:=]\s*)"?[^",\s}]+"?/gi,
    '$1"[redacted]"',
  ],
  [/\bEK1\.[A-Za-z0-9_-]+\.\d+\.\d{8}\b/g, 'EK1.[redacted]'],
];

export function redact(s: string): string {
  let out = s;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

class Logger extends EventEmitter {
  private dir: string | null = null;
  private ring: LogLine[] = [];

  init(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.dir = dir;
  }

  get file() {
    return this.dir ? join(this.dir, 'eventkit.log') : null;
  }

  recent(): LogLine[] {
    return [...this.ring];
  }

  log(level: LogLine['level'], scope: string, msg: string) {
    const line: LogLine = { t: Date.now(), level, scope, msg: redact(msg).slice(0, 4000) };
    this.ring.push(line);
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING);
    this.emit('line', line);
    const text = `${new Date(line.t).toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${line.msg}\n`;
    if (process.env['NODE_ENV'] !== 'test' && !this.dir) process.stdout.write(text);
    if (!this.dir) return;
    try {
      this.rotate();
      appendFileSync(this.file!, text);
    } catch {
      // logging must never crash the app
    }
  }

  private rotate() {
    const f = this.file!;
    if (!existsSync(f) || statSync(f).size < MAX_BYTES) return;
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = `${f}.${i}`;
      if (existsSync(from)) renameSync(from, `${f}.${i + 1}`);
    }
    renameSync(f, `${f}.1`);
  }

  scope(scope: string) {
    return {
      debug: (m: string) => this.log('debug', scope, m),
      info: (m: string) => this.log('info', scope, m),
      warn: (m: string) => this.log('warn', scope, m),
      error: (m: string) => this.log('error', scope, m),
    };
  }
}

export const logger = new Logger();
export type ScopedLogger = ReturnType<Logger['scope']>;

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
