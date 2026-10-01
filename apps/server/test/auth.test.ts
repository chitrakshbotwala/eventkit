import { afterEach, describe, expect, it } from 'vitest';
import { SIGNIN_CODE_TTL_MS, SIGNIN_REQUEST_TTL_MS } from '@eventkit/shared';
import type { GoogleIdentity, IdentityProvider } from '../src/services/google';
import {
  addAttendee,
  browserSignIn,
  callback,
  device,
  exchange,
  json,
  LOOPBACK_PORT,
  loginAttendee,
  loopback,
  makeApp,
  pkce,
  providerState,
  startSignIn,
  type TestApp,
} from './helpers';

let t: TestApp;
afterEach(async () => t.close());

async function setup(identity?: IdentityProvider) {
  t = await makeApp({ identity });
  await addAttendee(t, 'asha@example.com', 'Asha Rao');
}

/** Stands in for Google: the callback's `code` is ignored, the identity is fixed. */
function fakeGoogle(identity: Partial<GoogleIdentity> = {}): IdentityProvider & { calls: number } {
  const p = {
    kind: 'google' as const,
    calls: 0,
    authorizeUrl: ({ state }: { state: string }) =>
      `https://accounts.google.test/auth?state=${state}`,
    exchange: async () => {
      p.calls++;
      return { sub: '42', email: 'asha@example.com', emailVerified: true, ...identity };
    },
  };
  return p;
}

describe('Google sign-in (desktop loopback + PKCE)', () => {
  it('signs in an RSVP attendee and returns token, device key and server time', async () => {
    await setup();
    const { verifier, challenge } = pkce();
    const cb = await browserSignIn(t, 'Asha@Example.com', challenge);
    expect(cb.statusCode).toBe(302);
    const target = loopback(cb);
    expect(`${target.protocol}//${target.host}${target.pathname}`).toBe(
      `http://127.0.0.1:${LOOPBACK_PORT}/callback`,
    );
    expect(target.searchParams.get('state')).toBe('app-state-0123456789');

    const res = await exchange(t, target.searchParams.get('code')!, verifier);
    expect(res.statusCode).toBe(200);
    const body = json<{
      token: string;
      deviceKey: string;
      serverTime: number;
      attendee: { status: string; ready: boolean; email: string };
    }>(res);
    expect(body.token.length).toBeGreaterThan(30);
    expect(Buffer.from(body.deviceKey, 'base64')).toHaveLength(32);
    expect(body.serverTime).toBe(t.clock.now);
    expect(body.attendee).toMatchObject({
      status: 'logged_in',
      ready: false,
      email: 'asha@example.com',
    });

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('tells the app when the Google account is not on the RSVP list', async () => {
    await setup();
    const cb = await browserSignIn(t, 'stranger@gmail.com', pkce().challenge);
    const target = loopback(cb);
    expect(target.searchParams.get('code')).toBeNull();
    expect(target.searchParams.get('error')).toBe('not_registered');
    expect(target.searchParams.get('email')).toBe('stranger@gmail.com');
    expect(target.searchParams.get('message')).toMatch(/not on the RSVP list/);
    expect(await t.prisma.session.count()).toBe(0);
    const audit = await t.prisma.auditLog.findFirstOrThrow({
      where: { action: 'auth.not_registered' },
    });
    expect(audit.data).not.toContain('stranger');
  });

  it('refuses Google accounts without a verified email', async () => {
    await setup(fakeGoogle({ emailVerified: false }));
    const start = await startSignIn(t);
    const cb = await callback(t, { state: providerState(start), code: 'google-code' });
    expect(loopback(cb).searchParams.get('error')).toBe('email_unverified');
  });

  it('reports a cancelled Google consent to the app', async () => {
    const google = fakeGoogle();
    await setup(google);
    const start = await startSignIn(t);
    const cb = await callback(t, { state: providerState(start), error: 'access_denied' });
    expect(loopback(cb).searchParams.get('error')).toBe('cancelled');
    expect(google.calls).toBe(0);
  });

  it('sends the browser to Google with PKCE and a nonce, never the client secret', async () => {
    await setup(
      (await import('../src/services/google')).googleProvider({
        clientId: 'cid.apps.googleusercontent.com',
        clientSecret: 'super-secret',
        redirectUri: 'https://event.test/auth/google/callback',
        now: Date.now,
      }),
    );
    const start = await startSignIn(t);
    const url = new URL(String(start.headers.location));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe('https://event.test/auth/google/callback');
    expect(url.toString()).not.toContain('super-secret');
    expect(
      (await t.app.inject({ method: 'GET', url: '/auth/google/dev?state=x' })).statusCode,
    ).toBe(404);
  });

  it('accepts each Google callback once (no replay)', async () => {
    const google = fakeGoogle();
    await setup(google);
    const start = await startSignIn(t);
    const state = providerState(start);
    expect((await callback(t, { state, code: 'c' })).statusCode).toBe(302);
    const replay = await callback(t, { state, code: 'c' });
    expect(replay.statusCode).toBe(400);
    expect(replay.headers['content-type']).toMatch(/text\/html/);
    expect((await callback(t, { state: 'made-up', code: 'c' })).statusCode).toBe(400);
    expect(google.calls).toBe(1);
  });

  it('expires the browser step after 10 minutes', async () => {
    await setup(fakeGoogle());
    const start = await startSignIn(t);
    t.clock.now += SIGNIN_REQUEST_TTL_MS + 1;
    const cb = await callback(t, { state: providerState(start), code: 'c' });
    expect(loopback(cb).searchParams.get('error')).toBe('expired');
  });

  it('one-time code: single use, short-lived and bound to the PKCE verifier', async () => {
    await setup();
    const a = pkce();
    const codeA = loopback(
      await browserSignIn(t, 'asha@example.com', a.challenge),
    ).searchParams.get('code')!;
    expect((await exchange(t, codeA, a.verifier)).statusCode).toBe(200);
    expect((await exchange(t, codeA, a.verifier)).statusCode).toBe(400);

    // Wrong verifier burns the code, so an intercepted code is useless.
    const b = pkce();
    const codeB = loopback(
      await browserSignIn(t, 'asha@example.com', b.challenge),
    ).searchParams.get('code')!;
    expect((await exchange(t, codeB, pkce().verifier)).statusCode).toBe(400);
    expect((await exchange(t, codeB, b.verifier)).statusCode).toBe(400);

    const c = pkce();
    const codeC = loopback(
      await browserSignIn(t, 'asha@example.com', c.challenge),
    ).searchParams.get('code')!;
    t.clock.now += SIGNIN_CODE_TTL_MS + 1;
    const late = await exchange(t, codeC, c.verifier);
    expect(late.statusCode).toBe(400);
    expect(json(late).error).toBe('invalid_code');
  });

  it('validates the start link and the exchange body', async () => {
    await setup();
    expect((await startSignIn(t, { port: 80 })).statusCode).toBe(400);
    expect((await startSignIn(t, { challenge: 'short' })).statusCode).toBe(400);
    expect((await startSignIn(t, { state: 'has spaces and is long' })).statusCode).toBe(400);
    const bad = await t.app.inject({
      method: 'POST',
      url: '/auth/google/exchange',
      payload: { code: 'x', verifier: 'y', device: { os: 'amiga' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error).toBe('validation_error');
  });

  it('only redirects to the loopback interface', async () => {
    await setup(fakeGoogle());
    const start = await startSignIn(t, { port: 61000 });
    const cb = await callback(t, { state: providerState(start), code: 'c' });
    expect(String(cb.headers.location)).toMatch(/^http:\/\/127\.0\.0\.1:61000\/callback\?/);
  });

  it('reuses the device key for the same device and revokes on logout', async () => {
    await setup();
    const a = await loginAttendee(t, 'asha@example.com');
    const b = await loginAttendee(t, 'asha@example.com');
    expect(b.deviceKey).toBe(a.deviceKey);
    expect(b.deviceId).toBe(a.deviceId);
    const other = await loginAttendee(
      t,
      'asha@example.com',
      device({ clientDeviceId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d' }),
    );
    expect(other.deviceKey).not.toBe(a.deviceKey);

    const out = await t.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(out.statusCode).toBe(200);
    const me = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(me.statusCode).toBe(401);
  });

  it('requires a bearer token for attendee APIs', async () => {
    await setup();
    expect((await t.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const bad = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.statusCode).toBe(401);
  });

  it('stores only hashes of codes and writes audit entries without secrets', async () => {
    await setup();
    const { verifier, challenge } = pkce();
    const code = loopback(await browserSignIn(t, 'asha@example.com', challenge)).searchParams.get(
      'code',
    )!;
    const row = await t.prisma.signInRequest.findFirstOrThrow({
      where: { codeHash: { not: null } },
    });
    expect(row.codeHash).not.toContain(code);
    await exchange(t, code, verifier);
    const logs = await t.prisma.auditLog.findMany();
    expect(logs.map((l) => l.action)).toContain('auth.login');
    expect(JSON.stringify(logs)).not.toContain(code);
    expect(JSON.parse(logs.find((l) => l.action === 'auth.login')!.data)).toMatchObject({
      method: 'dev',
    });
  });
});
