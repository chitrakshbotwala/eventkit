import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OTP_COOLDOWN_MS } from '@eventkit/shared';
import {
  addAttendee,
  device,
  json,
  lastCode,
  loginAttendee,
  makeApp,
  type TestApp,
} from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await addAttendee(t, 'asha@example.com', 'Asha Rao');
});
afterEach(async () => t.close());

const request = (email: string) =>
  t.app.inject({ method: 'POST', url: '/auth/request-otp', payload: { email } });
const verify = (email: string, code: string) =>
  t.app.inject({
    method: 'POST',
    url: '/auth/verify-otp',
    payload: { email, code, device: device() },
  });

describe('attendee OTP auth', () => {
  it('sends a code only to RSVP emails but responds identically (no enumeration)', async () => {
    const known = await request('Asha@Example.com');
    const unknown = await request('stranger@example.com');
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(json(known)).toEqual(json(unknown));
    expect(json(known).message).toMatch(/Contact the organizers/);
    expect(t.mails.map((m) => m.to)).toEqual(['asha@example.com']);
  });

  it('stores OTPs hashed, never in plain text', async () => {
    await request('asha@example.com');
    const code = lastCode(t, 'asha@example.com');
    const row = await t.prisma.otpCode.findFirstOrThrow();
    expect(row.codeHash).not.toContain(code);
    expect(row.codeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('logs in with a valid code and returns token, device key and server time', async () => {
    await request('asha@example.com');
    const res = await verify('asha@example.com', lastCode(t, 'asha@example.com'));
    expect(res.statusCode).toBe(200);
    const body = json<{
      token: string;
      deviceKey: string;
      serverTime: number;
      attendee: { status: string; ready: boolean };
    }>(res);
    expect(body.token.length).toBeGreaterThan(30);
    expect(Buffer.from(body.deviceKey, 'base64')).toHaveLength(32);
    expect(body.serverTime).toBe(t.clock.now);
    expect(body.attendee).toMatchObject({ status: 'logged_in', ready: false });

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(json<{ attendee: { email: string } }>(me).attendee.email).toBe('asha@example.com');
  });

  it('rejects a code twice (single use)', async () => {
    await request('asha@example.com');
    const code = lastCode(t, 'asha@example.com');
    expect((await verify('asha@example.com', code)).statusCode).toBe(200);
    expect((await verify('asha@example.com', code)).statusCode).toBe(400);
  });

  it('expires codes after 10 minutes', async () => {
    await request('asha@example.com');
    const code = lastCode(t, 'asha@example.com');
    t.clock.now += 10 * 60_000 + 1;
    const res = await verify('asha@example.com', code);
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('invalid_code');
  });

  it('locks the code after 5 wrong attempts', async () => {
    await request('asha@example.com');
    const code = lastCode(t, 'asha@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      expect((await verify('asha@example.com', wrong)).statusCode).toBe(400);
    expect((await verify('asha@example.com', code)).statusCode).toBe(400);
  });

  it('invalidates the previous code when a new one is requested', async () => {
    await request('asha@example.com');
    const first = lastCode(t, 'asha@example.com');
    t.clock.now += OTP_COOLDOWN_MS + 1;
    await request('asha@example.com');
    const second = lastCode(t, 'asha@example.com');
    if (first !== second) expect((await verify('asha@example.com', first)).statusCode).toBe(400);
    expect((await verify('asha@example.com', second)).statusCode).toBe(200);
  });

  it('rate-limits OTP requests per email (cooldown + window), for unknown emails too', async () => {
    expect((await request('asha@example.com')).statusCode).toBe(200);
    const cool = await request('asha@example.com');
    expect(cool.statusCode).toBe(429);
    expect(cool.headers['retry-after']).toBeDefined();
    t.clock.now += OTP_COOLDOWN_MS + 1;
    expect((await request('asha@example.com')).statusCode).toBe(200);
    t.clock.now += OTP_COOLDOWN_MS + 1;
    expect((await request('asha@example.com')).statusCode).toBe(200);
    t.clock.now += OTP_COOLDOWN_MS + 1;
    expect((await request('asha@example.com')).statusCode).toBe(429);

    expect((await request('ghost@example.com')).statusCode).toBe(200);
    expect((await request('ghost@example.com')).statusCode).toBe(429);
  });

  it('validates input with zod', async () => {
    expect((await request('not-an-email')).statusCode).toBe(400);
    const bad = await t.app.inject({
      method: 'POST',
      url: '/auth/verify-otp',
      payload: { email: 'asha@example.com', code: '12', device: { os: 'amiga' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error).toBe('validation_error');
  });

  it('reuses the device key for the same device and revokes on logout', async () => {
    const a = await loginAttendee(t, 'asha@example.com');
    t.clock.now += OTP_COOLDOWN_MS + 1;
    const b = await loginAttendee(t, 'asha@example.com');
    expect(b.deviceKey).toBe(a.deviceKey);
    expect(b.deviceId).toBe(a.deviceId);
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
    expect((await t.app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/api/me',
          headers: { authorization: 'Bearer nope' },
        })
      ).statusCode,
    ).toBe(401);
  });

  it('writes audit entries without secrets', async () => {
    await loginAttendee(t, 'asha@example.com');
    const logs = await t.prisma.auditLog.findMany();
    expect(logs.map((l) => l.action)).toEqual(
      expect.arrayContaining(['otp.request', 'auth.login']),
    );
    const code = lastCode(t, 'asha@example.com');
    expect(JSON.stringify(logs)).not.toContain(code);
  });
});
