import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { artifactUrls, Downloader, HashMismatchError } from '../src/main/setup/downloader';

const body = randomBytes(2 * 1024 * 1024 + 123);
const sha = createHash('sha256').update(body).digest('hex');

interface Behavior {
  /** Drop the connection after this many bytes on the first N requests. */
  dropAfter?: number;
  dropTimes?: number;
  ignoreRange?: boolean;
  corrupt?: boolean;
  status?: number;
}

let server: Server;
let base = '';
const behaviors = new Map<string, Behavior>();
const requests: Array<{ path: string; range?: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    const b = behaviors.get(path) ?? {};
    requests.push({ path, range: req.headers.range });
    if (b.status) {
      res.writeHead(b.status);
      res.end();
      return;
    }
    const data = b.corrupt ? Buffer.from(body).fill(0, 1000, 2000) : body;
    let start = 0;
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (m && !b.ignoreRange) {
      start = Number(m[1]);
      if (start >= data.length) {
        res.writeHead(416);
        res.end();
        return;
      }
      res.writeHead(206, {
        'content-length': data.length - start,
        'content-range': `bytes ${start}-${data.length - 1}/${data.length}`,
      });
    } else {
      res.writeHead(200, { 'content-length': data.length });
    }
    const slice = data.subarray(start);
    if (b.dropAfter !== undefined && (b.dropTimes ?? 1) > 0) {
      b.dropTimes = (b.dropTimes ?? 1) - 1;
      res.write(slice.subarray(0, b.dropAfter), () => res.destroy());
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ek-dl-'));
  behaviors.clear();
  requests.length = 0;
});

const logs: string[] = [];
const dl = (opts = {}) =>
  new Downloader(
    { fetch: (u, i) => fetch(u, i), log: (m) => logs.push(m), sleep: async () => undefined },
    { maxAttempts: 4, ...opts },
  );

describe('Downloader', () => {
  it('downloads and verifies SHA-256', async () => {
    const dest = join(dir, 'a.zip');
    const progress: number[] = [];
    await dl().download(
      { urls: [`${base}/a`], dest, sha256: sha, size: body.length, label: 'a' },
      (p) => progress.push(p.bytesDone),
    );
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(progress.at(-1)).toBe(body.length);
  });

  it('resumes with an HTTP Range request after a mid-transfer network drop', async () => {
    behaviors.set('/b', { dropAfter: 900_000, dropTimes: 1 });
    const dest = join(dir, 'b.zip');
    await dl().download({ urls: [`${base}/b`], dest, sha256: sha, label: 'b' });
    expect(readFileSync(dest).equals(body)).toBe(true);
    const ranges = requests.filter((r) => r.path === '/b').map((r) => r.range);
    expect(ranges[0]).toBeUndefined();
    // Resumes from whatever arrived before the drop (TCP buffering makes the exact offset vary).
    const offset = Number(/^bytes=(\d+)-$/.exec(ranges[1] ?? '')?.[1]);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(900_000);
  });

  it('resumes a .part file left over from a previous run (app restart)', async () => {
    const dest = join(dir, 'c.zip');
    writeFileSync(`${dest}.part`, body.subarray(0, 1_500_000));
    await dl().download({ urls: [`${base}/c`], dest, sha256: sha, label: 'c' });
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(requests[0]!.range).toBe('bytes=1500000-');
  });

  it('restarts from zero when the server ignores Range', async () => {
    behaviors.set('/d', { ignoreRange: true });
    const dest = join(dir, 'd.zip');
    writeFileSync(`${dest}.part`, Buffer.alloc(500_000, 7)); // garbage partial
    await dl().download({ urls: [`${base}/d`], dest, sha256: sha, label: 'd' });
    expect(readFileSync(dest).equals(body)).toBe(true);
  });

  it('deletes corrupt downloads and fails on hash mismatch', async () => {
    behaviors.set('/e', { corrupt: true });
    const dest = join(dir, 'e.zip');
    await expect(
      dl().download({ urls: [`${base}/e`], dest, sha256: sha, label: 'e' }),
    ).rejects.toBeInstanceOf(HashMismatchError);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it('falls back from the mirror to the official URL', async () => {
    behaviors.set('/mirror/f', { status: 404 });
    const dest = join(dir, 'f.zip');
    await dl().download({ urls: [`${base}/mirror/f`, `${base}/f`], dest, sha256: sha, label: 'f' });
    expect(requests.map((r) => r.path)).toEqual(['/mirror/f', '/f']);
  });

  it('falls back when the mirror serves a bad file', async () => {
    behaviors.set('/mirror/g', { corrupt: true });
    const dest = join(dir, 'g.zip');
    await dl().download({ urls: [`${base}/mirror/g`, `${base}/g`], dest, sha256: sha, label: 'g' });
    expect(readFileSync(dest).equals(body)).toBe(true);
  });

  it('retries 5xx errors with backoff, then gives up', async () => {
    behaviors.set('/h', { status: 503 });
    await expect(
      dl({ maxAttempts: 3 }).download({
        urls: [`${base}/h`],
        dest: join(dir, 'h'),
        sha256: sha,
        label: 'h',
      }),
    ).rejects.toThrow(/503/);
    expect(requests.length).toBe(3);
  });

  it('skips the download when a verified file already exists (idempotent)', async () => {
    const dest = join(dir, 'i.zip');
    writeFileSync(dest, body);
    await dl().download({ urls: [`${base}/i`], dest, sha256: sha, label: 'i' });
    expect(requests.length).toBe(0);
  });

  it('can be cancelled', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      dl().download(
        { urls: [`${base}/j`], dest: join(dir, 'j'), sha256: sha, label: 'j' },
        undefined,
        ctrl.signal,
      ),
    ).rejects.toThrow(/cancelled/);
  });
});

describe('artifactUrls', () => {
  it('puts the mirror first when configured', () => {
    const a = {
      url: 'https://dl.example/flutter.zip',
      mirrorPath: 'flutter/3.35.4/flutter windows.zip',
    };
    expect(artifactUrls(a, 'http://10.0.0.5:8080/mirror/')).toEqual([
      'http://10.0.0.5:8080/mirror/flutter/3.35.4/flutter%20windows.zip',
      'https://dl.example/flutter.zip',
    ]);
    expect(artifactUrls(a, null)).toEqual(['https://dl.example/flutter.zip']);
  });
});
