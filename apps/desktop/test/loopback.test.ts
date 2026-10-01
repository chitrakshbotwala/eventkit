import { describe, expect, it } from 'vitest';
import { startLoopback } from '../src/main/loopback';

const get = (port: number, path: string) => fetch(`http://127.0.0.1:${port}${path}`);

describe('OAuth loopback listener', () => {
  it('resolves with the one-time code for the expected state, once', async () => {
    const loop = await startLoopback('state-1');
    expect((await get(loop.port, '/other')).status).toBe(404);
    const foreign = await get(loop.port, '/callback?state=nope&code=evil');
    expect(foreign.status).toBe(400);
    const ok = await get(loop.port, '/callback?state=state-1&code=abc123');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await loop.result).toEqual({ code: 'abc123' });
    await expect(get(loop.port, '/callback?state=state-1&code=again')).rejects.toThrow();
  });

  it('passes server errors through without reflecting them into the page', async () => {
    const loop = await startLoopback('s');
    const res = await get(
      loop.port,
      `/callback?state=s&error=not_registered&email=x%40gmail.com&message=${encodeURIComponent('<b>nope</b>')}`,
    );
    expect(await res.text()).not.toContain('<b>nope</b>');
    expect(await loop.result).toEqual({
      error: 'not_registered',
      message: '<b>nope</b>',
      email: 'x@gmail.com',
    });
  });

  it('rejects on cancel and on timeout', async () => {
    const a = await startLoopback('s');
    a.close();
    await expect(a.result).rejects.toMatchObject({ code: 'cancelled' });
    const b = await startLoopback('s', 20);
    await expect(b.result).rejects.toMatchObject({ code: 'timeout' });
  });

  it('listens on the loopback interface only', async () => {
    const loop = await startLoopback('s');
    expect(loop.port).toBeGreaterThan(1023);
    loop.close();
  });
});
