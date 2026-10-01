import { net } from 'electron';
import type { ZodType } from 'zod';
import { TimeResponseSchema } from '@eventkit/shared';
import { config, paths } from './config';
import { logger } from './logger';
import { secureStore } from './secure-store';
import { readJson, writeJson } from './store';

const log = logger.scope('api');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get offline() {
    return this.status === 0;
  }
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  auth?: boolean;
  timeoutMs?: number;
}

/**
 * HTTP client for the event server. Uses Electron's `net` stack, which honours
 * system proxy settings (PAC/WPAD/manual) and the OS certificate store.
 */
class ApiClient {
  /** serverTime - localTime, estimated with RTT correction. */
  private offsetMs = readJson<{ offsetMs?: number }>(paths.file('clock.json'), {}).offsetMs ?? 0;

  get serverOffsetMs() {
    return this.offsetMs;
  }

  url(path: string) {
    return `${config.apiBaseUrl}${path}`;
  }

  async request<T>(path: string, schema: ZodType<T> | null, opts: RequestOpts = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth) {
      const token = secureStore.get('sessionToken');
      if (!token) throw new ApiError(401, 'unauthorized', 'Not signed in');
      headers['authorization'] = `Bearer ${token}`;
    }
    let res: Response;
    try {
      res = await net.fetch(this.url(path), {
        method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        cache: 'no-store',
      });
    } catch (err) {
      throw new ApiError(
        0,
        'offline',
        `Cannot reach the event server (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON error page (proxy, captive portal)
    }
    if (!res.ok) {
      const body = (json ?? {}) as { error?: string; message?: string };
      throw new ApiError(
        res.status,
        body.error ?? 'http_error',
        body.message ?? `Server returned ${res.status}`,
      );
    }
    if (!schema) return json as T;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      log.error(`unexpected response shape from ${path}`);
      throw new ApiError(res.status, 'bad_response', 'Unexpected response from server');
    }
    return parsed.data;
  }

  /** Measure the server clock offset (for QR windows and log timestamps). */
  async syncClock(): Promise<number> {
    const t0 = Date.now();
    const { now } = await this.request('/api/time', TimeResponseSchema, { timeoutMs: 5_000 });
    const t1 = Date.now();
    this.setOffset(now - (t0 + t1) / 2);
    return this.offsetMs;
  }

  setOffset(offset: number) {
    this.offsetMs = Math.round(offset);
    writeJson(paths.file('clock.json'), { offsetMs: this.offsetMs, at: Date.now() });
  }
}

export const api = new ApiClient();
