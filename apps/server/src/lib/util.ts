import { createHmac } from 'node:crypto';
import { sha256Hex } from '@eventkit/shared/node';

/** Session tokens are stored only as SHA-256 hashes. */
export const hashToken = (token: string) => sha256Hex(`token:${token}`);

export function hmacHex(key: string, data: string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function jsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Tiny in-memory sliding-window limiter (single server instance). */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Returns 0 when allowed (and records the hit), or seconds to wait. */
  take(key: string, now = Date.now()): number {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) {
      this.hits.set(key, arr);
      return Math.ceil((this.windowMs - (now - arr[0]!)) / 1000);
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 50_000) this.prune(now);
    return 0;
  }

  last(key: string): number | undefined {
    const arr = this.hits.get(key);
    return arr?.[arr.length - 1];
  }

  private prune(now: number) {
    for (const [k, v] of this.hits) {
      if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
  }
}

/** Case-insensitive `contains` filter (SQLite LIKE is already case-insensitive for ASCII). */
export function containsCI(databaseUrl: string, value: string) {
  return databaseUrl.startsWith('postgres')
    ? { contains: value, mode: 'insensitive' as const }
    : { contains: value };
}
