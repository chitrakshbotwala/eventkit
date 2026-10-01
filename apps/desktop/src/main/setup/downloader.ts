import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

export interface DownloadRequest {
  /** Tried in order (LAN mirror first, then official). */
  urls: string[];
  dest: string;
  sha256: string;
  size?: number;
  label: string;
}

export interface DownloadProgress {
  bytesDone: number;
  bytesTotal?: number;
  speedBps: number;
  etaSeconds?: number;
  url: string;
  attempt: number;
}

export interface DownloaderDeps {
  fetch: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<Response>;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface DownloaderOptions {
  concurrency: number;
  /** Attempts per URL before moving to the next one. */
  maxAttempts: number;
  /** Abort and resume when no bytes arrive for this long. */
  stallMs: number;
  maxBackoffMs: number;
}

export class HashMismatchError extends Error {
  constructor(
    readonly url: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `SHA-256 mismatch for ${url}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
    );
    this.name = 'HashMismatchError';
  }
}

export class HttpStatusError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
  }
  get retryable() {
    return this.status >= 500 || this.status === 408 || this.status === 429;
  }
}

export async function sha256File(path: string, hash: Hash = createHash('sha256')): Promise<string> {
  await pipeline(
    createReadStream(path),
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        cb();
      },
    }),
  );
  return hash.digest('hex');
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    return () => {
      this.active--;
      this.queue.shift()?.();
    };
  }
}

/**
 * Resumable, verified downloads:
 * - HTTP Range resume from `<dest>.part` (re-hashing the existing bytes first)
 * - retries with exponential backoff + jitter, stall detection
 * - SHA-256 verification; corrupt files are deleted
 * - mirror-then-official URL fallback, global concurrency limit
 */
export class Downloader {
  private sem: Semaphore;
  private opts: DownloaderOptions;

  constructor(
    private readonly deps: DownloaderDeps,
    opts: Partial<DownloaderOptions> = {},
  ) {
    this.opts = { concurrency: 2, maxAttempts: 8, stallMs: 30_000, maxBackoffMs: 30_000, ...opts };
    this.sem = new Semaphore(this.opts.concurrency);
  }

  private sleep(ms: number) {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms));
  }

  async download(
    req: DownloadRequest,
    onProgress?: (p: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    await mkdir(dirname(req.dest), { recursive: true });
    if ((await fileSize(req.dest)) > 0) {
      if ((await sha256File(req.dest)) === req.sha256) {
        this.deps.log(`${req.label}: already downloaded and verified`);
        return req.dest;
      }
      this.deps.log(`${req.label}: existing file failed verification, re-downloading`);
      await rm(req.dest, { force: true });
    }

    const release = await this.sem.acquire();
    try {
      let lastErr: unknown = null;
      for (const url of req.urls) {
        for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
          if (signal?.aborted) throw new Error('cancelled');
          try {
            await this.attempt(req, url, attempt, onProgress, signal);
            await rename(`${req.dest}.part`, req.dest);
            this.deps.log(`${req.label}: downloaded and verified from ${new URL(url).host}`);
            return req.dest;
          } catch (err) {
            lastErr = err;
            if (signal?.aborted) throw new Error('cancelled');
            if (err instanceof HashMismatchError) {
              await rm(`${req.dest}.part`, { force: true });
              // A resumed file may have been corrupt: retry once from scratch, then give up on this URL.
              if (attempt >= 2) break;
              this.deps.log(`${req.label}: ${err.message}; retrying from scratch`);
              continue;
            }
            if (err instanceof HttpStatusError && !err.retryable) {
              this.deps.log(`${req.label}: ${err.message}; trying next source`);
              break;
            }
            const backoff = Math.min(this.opts.maxBackoffMs, 1000 * 2 ** (attempt - 1));
            const wait = backoff / 2 + Math.random() * (backoff / 2);
            this.deps.log(
              `${req.label}: attempt ${attempt}/${this.opts.maxAttempts} failed (${err instanceof Error ? err.message : String(err)}); retrying in ${Math.round(wait / 1000)}s`,
            );
            await this.sleep(wait);
          }
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(`download failed: ${req.label}`);
    } finally {
      release();
    }
  }

  private async attempt(
    req: DownloadRequest,
    url: string,
    attempt: number,
    onProgress: ((p: DownloadProgress) => void) | undefined,
    outer: AbortSignal | undefined,
  ): Promise<void> {
    const part = `${req.dest}.part`;
    let offset = await fileSize(part);
    if (req.size && offset > req.size) {
      await rm(part, { force: true });
      offset = 0;
    }

    const ctrl = new AbortController();
    const onOuterAbort = () => ctrl.abort(new Error('cancelled'));
    outer?.addEventListener('abort', onOuterAbort, { once: true });
    let stallTimer: NodeJS.Timeout | null = null;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => ctrl.abort(new Error(`stalled for ${this.opts.stallMs / 1000}s`)),
        this.opts.stallMs,
      );
    };

    try {
      armStall();
      const headers: Record<string, string> = { 'user-agent': 'EventKit-Setup' };
      if (offset > 0) headers['range'] = `bytes=${offset}-`;
      const res = await this.deps.fetch(url, { headers, signal: ctrl.signal });

      if (res.status === 416 && offset > 0) {
        // Server says our range starts at/after EOF: the partial may already be complete.
        await res.body?.cancel();
        const actual = await sha256File(part);
        if (actual === req.sha256) return;
        await rm(part, { force: true });
        throw new Error('partial file invalid after range 416, restarting');
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new HttpStatusError(url, res.status);
      }
      let append = false;
      if (offset > 0 && res.status === 206) {
        const cr = res.headers.get('content-range');
        const start = cr ? Number(/bytes\s+(\d+)-/.exec(cr)?.[1]) : NaN;
        append = start === offset;
      }
      if (!append) offset = 0;

      const hash = createHash('sha256');
      if (append) {
        this.deps.log(`${req.label}: resuming at ${(offset / 1e6).toFixed(1)} MB`);
        await pipeline(
          createReadStream(part, { start: 0, end: offset - 1 }),
          new Writable({
            write(chunk: Buffer, _e, cb) {
              hash.update(chunk);
              cb();
            },
          }),
        );
      }
      const lenHeader = Number(res.headers.get('content-length') ?? NaN);
      const bytesTotal = Number.isFinite(lenHeader) ? offset + lenHeader : req.size;
      if (!res.body) throw new Error('empty response body');

      const out = createWriteStream(part, { flags: append ? 'a' : 'w' });
      const now = this.deps.now ?? Date.now;
      let done = offset;
      let windowStart = now();
      let windowBytes = 0;
      let speed = 0;
      let lastEmit = 0;
      const emit = (force = false) => {
        const t = now();
        if (!force && t - lastEmit < 250) return;
        lastEmit = t;
        onProgress?.({
          bytesDone: done,
          bytesTotal,
          speedBps: speed,
          etaSeconds:
            bytesTotal && speed > 0 ? Math.max(0, (bytesTotal - done) / speed) : undefined,
          url,
          attempt,
        });
      };

      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done: finished, value } = await reader.read();
          if (finished) break;
          armStall();
          hash.update(value);
          done += value.byteLength;
          windowBytes += value.byteLength;
          const t = now();
          if (t - windowStart >= 1000) {
            const inst = (windowBytes * 1000) / (t - windowStart);
            speed = speed === 0 ? inst : speed * 0.7 + inst * 0.3;
            windowStart = t;
            windowBytes = 0;
          }
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
          emit();
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          out.end((err?: Error | null) => (err ? reject(err) : resolve())),
        );
      }
      emit(true);
      const actual = hash.digest('hex');
      if (actual !== req.sha256) throw new HashMismatchError(url, req.sha256, actual);
    } catch (err) {
      if (ctrl.signal.aborted && ctrl.signal.reason instanceof Error) throw ctrl.signal.reason;
      throw err;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      outer?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** Candidate URLs for an artifact: mirror first (when configured), then upstream. */
export function artifactUrls(
  artifact: { url: string; mirrorPath?: string },
  mirrorBaseUrl: string | null,
): string[] {
  const urls: string[] = [];
  if (mirrorBaseUrl && artifact.mirrorPath) {
    urls.push(
      `${mirrorBaseUrl.replace(/\/+$/, '')}/${artifact.mirrorPath.split('/').map(encodeURIComponent).join('/')}`,
    );
  }
  urls.push(artifact.url);
  return urls;
}
