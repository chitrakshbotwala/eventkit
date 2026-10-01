import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export type LoopbackResult = { code: string } | { error: string; message: string; email?: string };

/** Error with a machine-readable code (forwarded to the renderer over IPC). */
export class SignInError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface Loopback {
  port: number;
  /** Resolves with the server's redirect; rejects on timeout or close(). */
  result: Promise<LoopbackResult>;
  close(): void;
}

const page = (title: string, text: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f1f5f9;color:#0f172a}
main{max-width:26rem;padding:2rem;background:#fff;border-radius:1rem;box-shadow:0 10px 30px #0f172a1a;text-align:center}</style>
</head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

const SUCCESS = page('Signed in', 'You can close this tab and go back to EventKit.');
const FAILED = page('Sign-in did not complete', 'Go back to EventKit to see what happened.');
const FOREIGN = page(
  'Unknown sign-in',
  'This link does not belong to the EventKit window that is waiting. Go back to EventKit and try again.',
);

/**
 * One-shot HTTP listener on 127.0.0.1 for the OAuth redirect (RFC 8252 section 7.3).
 * Only `GET /callback` with the expected `state` is accepted; the pages it serves are
 * static, so nothing from the URL is reflected into them.
 */
export async function startLoopback(
  expectedState: string,
  timeoutMs = 10 * 60_000,
): Promise<Loopback> {
  let settle: ((r: LoopbackResult) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  const result = new Promise<LoopbackResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Callers may close() before awaiting `result`; never leave the rejection unhandled.
  result.catch(() => undefined);
  let done = false;

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, body: string) =>
      res
        .writeHead(status, {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          'cache-control': 'no-store',
          connection: 'close',
        })
        .end(body);
    if (req.method !== 'GET' || url.pathname !== '/callback' || done) {
      res.writeHead(404, { connection: 'close' }).end();
      return;
    }
    if (url.searchParams.get('state') !== expectedState) {
      send(400, FOREIGN);
      return;
    }
    done = true;
    const code = url.searchParams.get('code');
    if (code) {
      send(200, SUCCESS);
      settle?.({ code });
    } else {
      send(200, FAILED);
      settle?.({
        error: url.searchParams.get('error') ?? 'failed',
        message: url.searchParams.get('message') ?? 'Sign-in failed. Please try again.',
        email: url.searchParams.get('email') ?? undefined,
      });
    }
    res.on('finish', () => close());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  const timer = setTimeout(() => {
    fail?.(new SignInError('timeout', 'Sign-in timed out. Please try again.'));
    close();
  }, timeoutMs);

  function close() {
    clearTimeout(timer);
    if (!done) {
      done = true;
      fail?.(new SignInError('cancelled', 'Sign-in was cancelled.'));
    }
    server.close();
    server.closeAllConnections();
  }

  return { port, result, close };
}
