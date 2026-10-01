import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { totp } from '@eventkit/shared/node';
import { addAdmin, adminHeaders, json, loginAdmin, makeApp, type TestApp } from './helpers';

let t: TestApp;
beforeEach(async () => {
  t = await makeApp();
  await addAdmin(t, 'root@example.org', 'superadmin');
  await addAdmin(t, 'door@example.org', 'volunteer');
});
afterEach(async () => t.close());

describe('admin auth', () => {
  it('logs in with password and sets a hardened cookie', async () => {
    const { res, cookie } = await loginAdmin(t, 'root@example.org');
    expect(res.statusCode).toBe(200);
    expect(json(res).status).toBe('ok');
    const set = res.cookies.find((c) => c.name === 'ek_admin')!;
    expect(set.httpOnly).toBe(true);
    expect(set.sameSite).toBe('Strict');
    const me = await t.app.inject({ method: 'GET', url: '/admin/auth/me', headers: { cookie } });
    expect(json<{ admin: { role: string } }>(me).admin.role).toBe('superadmin');
  });

  it('rejects wrong passwords and unknown users identically', async () => {
    const a = await loginAdmin(t, 'root@example.org', 'wrong-password-123');
    const b = await loginAdmin(t, 'nobody@example.org', 'wrong-password-123');
    expect(a.res.statusCode).toBe(401);
    expect(b.res.statusCode).toBe(401);
    expect(json(a.res)).toEqual(json(b.res));
  });

  it('blocks cross-origin mutating requests', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      headers: { origin: 'https://evil.example' },
      payload: { email: 'root@example.org', password: 'correct-horse-battery' },
    });
    expect(res.statusCode).toBe(403);
    const { cookie } = await loginAdmin(t, 'root@example.org');
    const put = await t.app.inject({
      method: 'PUT',
      url: '/admin/settings',
      headers: { cookie, origin: 'https://evil.example' },
      payload: { minDiskGb: 20 },
    });
    expect(put.statusCode).toBe(403);
  });

  it('supports TOTP 2FA enrollment and enforcement', async () => {
    const { cookie } = await loginAdmin(t, 'root@example.org');
    const enroll = await t.app.inject({
      method: 'POST',
      url: '/admin/auth/totp/enroll',
      headers: adminHeaders(cookie),
    });
    const { secret, otpauthUrl } = json<{ secret: string; otpauthUrl: string }>(enroll);
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const confirm = await t.app.inject({
      method: 'POST',
      url: '/admin/auth/totp/confirm',
      headers: adminHeaders(cookie),
      payload: { code: totp(secret, t.clock.now) },
    });
    expect(confirm.statusCode).toBe(200);

    const step1 = await loginAdmin(t, 'root@example.org');
    expect(json(step1.res).status).toBe('totp_required');
    expect(step1.cookie).toBe('');
    const bad = await loginAdmin(
      t,
      'root@example.org',
      'correct-horse-battery',
      '000000' === totp(secret, t.clock.now) ? '111111' : '000000',
    );
    expect(bad.res.statusCode).toBe(401);
    const good = await loginAdmin(
      t,
      'root@example.org',
      'correct-horse-battery',
      totp(secret, t.clock.now),
    );
    expect(json(good.res).status).toBe('ok');
    expect(good.cookie).not.toBe('');
  });

  it('enforces roles: volunteers cannot manage attendees or settings', async () => {
    const { cookie } = await loginAdmin(t, 'door@example.org');
    expect(
      (await t.app.inject({ method: 'GET', url: '/admin/attendees', headers: { cookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (await t.app.inject({ method: 'GET', url: '/admin/settings', headers: { cookie } }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/admin/attendees/search?q=as',
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/admin/attendees' })).statusCode).toBe(401);
  });
});

describe('RSVP import', () => {
  it('upserts, dedupes and lower-cases emails', async () => {
    const { cookie } = await loginAdmin(t, 'root@example.org');
    const csv = [
      'Name,Email,Ticket',
      'Asha Rao,Asha@Example.com,GA',
      'Ben Okafor,ben@example.com,GA',
      'Asha R.,asha@example.com,GA',
      'Broken,not-an-email,GA',
      '',
    ].join('\n');
    const res = await t.app.inject({
      method: 'POST',
      url: '/admin/attendees/import',
      headers: adminHeaders(cookie),
      payload: { csv },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ created: 2, updated: 0, duplicates: 1, skipped: 1 });
    const again = await t.app.inject({
      method: 'POST',
      url: '/admin/attendees/import',
      headers: adminHeaders(cookie),
      payload: {
        csv: 'first name,last name,e-mail\nBen,Okafor-Smith,BEN@example.com\nChen,Wei,chen@example.com',
      },
    });
    expect(json(again)).toMatchObject({ created: 1, updated: 1 });
    const all = await t.prisma.attendee.findMany({ orderBy: { email: 'asc' } });
    expect(all.map((a) => [a.email, a.name])).toEqual([
      ['asha@example.com', 'Asha R.'],
      ['ben@example.com', 'Ben Okafor-Smith'],
      ['chen@example.com', 'Chen Wei'],
    ]);
    const list = await t.app.inject({
      method: 'GET',
      url: '/admin/attendees?q=ASHA',
      headers: { cookie },
    });
    expect(json<{ total: number }>(list).total).toBe(1);
  });

  it('handles header-less files and BOMs', async () => {
    const { cookie } = await loginAdmin(t, 'root@example.org');
    const res = await t.app.inject({
      method: 'POST',
      url: '/admin/attendees/import',
      headers: adminHeaders(cookie),
      payload: {
        csv: String.fromCharCode(0xfeff) + 'x@example.com,X Person\ny@example.com,Y Person',
      },
    });
    expect(json(res)).toMatchObject({ created: 2 });
  });
});

describe('schedule', () => {
  it('updates, bumps the version and exposes it publicly', async () => {
    const { cookie } = await loginAdmin(t, 'root@example.org');
    const start = new Date(t.clock.now + 3600_000).toISOString();
    const end = new Date(t.clock.now + 5 * 3600_000).toISOString();
    const put = await t.app.inject({
      method: 'PUT',
      url: '/admin/schedule',
      headers: adminHeaders(cookie),
      payload: {
        startAt: start,
        endAt: end,
        timezone: 'Asia/Kolkata',
        mode: 'lenient',
        graceSeconds: 60,
      },
    });
    expect(put.statusCode).toBe(200);
    const pub = json<{ schedule: { startAt: string; mode: string; version: number } }>(
      await t.app.inject({ method: 'GET', url: '/api/schedule' }),
    );
    expect(pub.schedule).toMatchObject({ startAt: start, mode: 'lenient', version: 2 });

    const bad = await t.app.inject({
      method: 'PUT',
      url: '/admin/schedule',
      headers: adminHeaders(cookie),
      payload: { startAt: end, endAt: start, timezone: 'UTC', mode: 'strict', graceSeconds: 60 },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('supports start now / end now', async () => {
    const { cookie } = await loginAdmin(t, 'root@example.org');
    const endEarly = await t.app.inject({
      method: 'POST',
      url: '/admin/schedule/end-now',
      headers: adminHeaders(cookie),
    });
    expect(endEarly.statusCode).toBe(400);
    const start = json<{ schedule: { startAt: string; endAt: string } }>(
      await t.app.inject({
        method: 'POST',
        url: '/admin/schedule/start-now',
        headers: adminHeaders(cookie),
      }),
    );
    expect(Date.parse(start.schedule.startAt)).toBe(t.clock.now);
    expect(Date.parse(start.schedule.endAt)).toBeGreaterThan(t.clock.now);
    t.clock.now += 60_000;
    const end = json<{ schedule: { endAt: string } }>(
      await t.app.inject({
        method: 'POST',
        url: '/admin/schedule/end-now',
        headers: adminHeaders(cookie),
      }),
    );
    expect(Date.parse(end.schedule.endAt)).toBe(t.clock.now);
    const audit = await t.prisma.auditLog.findMany({
      where: { action: { startsWith: 'schedule.' } },
    });
    expect(audit.map((a) => a.action).sort()).toEqual(['schedule.end_now', 'schedule.start_now']);
  });
});
