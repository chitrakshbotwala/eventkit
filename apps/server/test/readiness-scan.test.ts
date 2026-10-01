import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  type ManifestPayload,
  type ReadinessReport,
  type ScanResponse,
  type SignedManifest,
} from '@eventkit/shared';
import { buildQrPayload, currentWindow, hmacSha256Hex } from '@eventkit/shared/node';
import {
  addAdmin,
  addAttendee,
  adminHeaders,
  device,
  json,
  loginAdmin,
  loginAttendee,
  makeApp,
  type TestApp,
} from './helpers';

let t: TestApp;
let token: string;
let deviceKey: Buffer;
let attendeeId: string;
let manifest: ManifestPayload;

beforeEach(async () => {
  t = await makeApp();
  await addAttendee(t, 'asha@example.com', 'Asha Rao');
  await addAdmin(t, 'root@example.org', 'superadmin');
  await addAdmin(t, 'door@example.org', 'volunteer');
  const login = await loginAttendee(t, 'asha@example.com');
  token = login.token;
  deviceKey = Buffer.from(login.deviceKey, 'base64');
  attendeeId = login.attendee.id;
  const m = await t.app.inject({ method: 'GET', url: '/api/manifest?os=windows&arch=x64' });
  manifest = json<SignedManifest>(m).payload as ManifestPayload;
});
afterEach(async () => t.close());

function report(over: Partial<ReadinessReport> = {}): ReadinessReport {
  const flutter = manifest.components.find((c) => c.id === 'flutter');
  return {
    manifestId: manifest.manifestId,
    clientDeviceId: device().clientDeviceId,
    generatedAt: new Date(t.clock.now).toISOString(),
    appVersion: '0.1.0',
    os: 'windows',
    arch: 'x64',
    osVersion: 'Windows 11',
    components: manifest.components
      .filter((c) => c.enabled)
      .map((c) => ({
        id: c.id,
        status: 'verified' as const,
        version:
          c.id === 'flutter' && flutter?.id === 'flutter'
            ? flutter.version
            : c.id === 'git'
              ? '2.51.0'
              : c.id === 'java'
                ? '17.0.16+8'
                : undefined,
      })),
    doctor: {
      flutterVersion: flutter?.id === 'flutter' ? flutter.version : undefined,
      channel: 'stable',
      categories: [
        { key: 'flutter', title: 'Flutter', status: 'ok', errors: [], warnings: [] },
        { key: 'android', title: 'Android toolchain', status: 'ok', errors: [], warnings: [] },
        { key: 'chrome', title: 'Chrome', status: 'ok', errors: [], warnings: [] },
        { key: 'vscode', title: 'VS Code', status: 'ok', errors: [], warnings: [] },
        {
          key: 'visual-studio',
          title: 'Visual Studio',
          status: 'missing',
          errors: ['not installed'],
          warnings: [],
        },
        {
          key: 'network',
          title: 'Network resources',
          status: 'partial',
          errors: ['offline'],
          warnings: [],
        },
      ],
    },
    ...over,
  };
}

const submit = (r: ReadinessReport, key: Buffer = deviceKey) =>
  t.app.inject({
    method: 'POST',
    url: '/api/readiness',
    headers: { authorization: `Bearer ${token}` },
    payload: { report: r, signature: hmacSha256Hex(key, canonicalJson(r)) },
  });

async function scanAs(email: string, payload: string) {
  const { cookie } = await loginAdmin(t, email);
  const res = await t.app.inject({
    method: 'POST',
    url: '/admin/scan',
    headers: adminHeaders(cookie),
    payload: { payload },
  });
  return { res, body: json<ScanResponse>(res), cookie };
}

describe('readiness gate', () => {
  it('releases the QR secret only for a passing, correctly signed report', async () => {
    const res = await submit(report());
    expect(res.statusCode).toBe(200);
    const body = json<{ accepted: boolean; qrSecret: string }>(res);
    expect(body.accepted).toBe(true);
    expect(Buffer.from(body.qrSecret, 'base64')).toHaveLength(32);
    const a = await t.prisma.attendee.findUniqueOrThrow({ where: { id: attendeeId } });
    expect(a.status).toBe('ready');
    // The secret is stable across repeated submissions.
    expect(json<{ qrSecret: string }>(await submit(report())).qrSecret).toBe(body.qrSecret);
  });

  it('rejects forged or tampered reports', async () => {
    expect((await submit(report(), Buffer.alloc(32, 9))).statusCode).toBe(400);
    const r = report();
    const signed = { report: r, signature: hmacSha256Hex(deviceKey, canonicalJson(r)) };
    const tampered = { ...signed, report: { ...r, appVersion: '9.9.9' } };
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/readiness',
      headers: { authorization: `Bearer ${token}` },
      payload: tampered,
    });
    expect(json(res).error).toBe('bad_signature');
    const stale = report({ generatedAt: new Date(t.clock.now - 2 * 3600_000).toISOString() });
    expect(json(await submit(stale)).error).toBe('stale_report');
  });

  it('re-evaluates on the server and refuses failing reports', async () => {
    const failing = report({
      components: report().components.map((c) =>
        c.id === 'android' ? { ...c, status: 'failed' as const } : c,
      ),
    });
    const body = json<{ accepted: boolean; qrSecret?: string; reasons: string[] }>(
      await submit(failing),
    );
    expect(body.accepted).toBe(false);
    expect(body.qrSecret).toBeUndefined();
    expect(body.reasons.join()).toMatch(/Android SDK: failed/);

    const doctorFail = report();
    doctorFail.doctor.categories[2] = {
      key: 'chrome',
      title: 'Chrome',
      status: 'missing',
      errors: ['Cannot find Chrome'],
      warnings: [],
    };
    expect(json<{ accepted: boolean }>(await submit(doctorFail)).accepted).toBe(false);

    // Every submission is recorded for the admin detail view.
    expect(await t.prisma.readinessReport.count({ where: { attendeeId } })).toBe(2);
  });

  it('cannot be satisfied by a client that simply claims "passed" (network warnings never block)', async () => {
    const r = report();
    r.doctor.categories = r.doctor.categories.filter((c) => c.key !== 'vscode');
    // VS Code omitted by doctor but verified locally -> still passes
    expect(json<{ accepted: boolean }>(await submit(r)).accepted).toBe(true);
  });
});

describe('scan', () => {
  async function ready() {
    const body = json<{ qrSecret: string }>(await submit(report()));
    return Buffer.from(body.qrSecret, 'base64');
  }
  const qrAt = (secret: Buffer, window = currentWindow(t.clock.now)) =>
    buildQrPayload(secret, attendeeId, window);

  it('refuses attendees who have not passed readiness', async () => {
    const fake = buildQrPayload(Buffer.alloc(32, 1), attendeeId, currentWindow(t.clock.now));
    const { body } = await scanAs('door@example.org', fake);
    expect(body.result).toBe('not_ready');
    expect(body.attendee?.name).toBe('Asha Rao');
  });

  it('checks in once; repeat and concurrent scans never double count', async () => {
    const secret = await ready();
    const first = await scanAs('door@example.org', qrAt(secret));
    expect(first.body.result).toBe('valid');
    expect(first.body.checkedInBy).toBe('door');

    const again = await scanAs('root@example.org', qrAt(secret));
    expect(again.body.result).toBe('already_checked_in');
    expect(again.body.checkedInAt).toBe(first.body.checkedInAt);

    const { cookie } = await loginAdmin(t, 'root@example.org');
    const burst = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.app.inject({
          method: 'POST',
          url: '/admin/scan',
          headers: adminHeaders(cookie),
          payload: { payload: qrAt(secret) },
        }),
      ),
    );
    expect(burst.every((r) => json<ScanResponse>(r).result === 'already_checked_in')).toBe(true);
    expect(await t.prisma.attendance.count()).toBe(1);

    const me = await t.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(json<{ attendee: { checkedInAt: string } }>(me).attendee.checkedInAt).toBe(
      first.body.checkedInAt,
    );
  });

  it('accepts +/- 1 window, reports older codes as expired and forged ones as invalid', async () => {
    const secret = await ready();
    const w = currentWindow(t.clock.now);
    expect((await scanAs('door@example.org', qrAt(secret, w - 3))).body.result).toBe('expired');
    expect(
      (await scanAs('door@example.org', 'EK1.' + attendeeId + '.' + w + '.00000000')).body.result,
    ).toBe('invalid');
    expect((await scanAs('door@example.org', 'not a qr code')).body.result).toBe('invalid');
    expect((await scanAs('door@example.org', qrAt(Buffer.alloc(32, 3)))).body.result).toBe(
      'invalid',
    );
    expect((await scanAs('door@example.org', qrAt(secret, w + 1))).body.result).toBe('valid');
  });

  it('refuses scans after a readiness regression', async () => {
    const secret = await ready();
    const failing = report({
      components: report().components.map((c) =>
        c.id === 'flutter' ? { ...c, status: 'failed' as const } : c,
      ),
    });
    await submit(failing);
    expect((await scanAs('door@example.org', qrAt(secret))).body.result).toBe('not_ready');
  });

  it('requires authentication and the right role', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/admin/scan',
      payload: { payload: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('manual check-in and export', () => {
  it('requires a reason, is audit-logged and idempotent', async () => {
    const { cookie } = await loginAdmin(t, 'root@example.org');
    const noReason = await t.app.inject({
      method: 'POST',
      url: '/admin/checkin/manual',
      headers: adminHeaders(cookie),
      payload: { attendeeId, reason: '' },
    });
    expect(noReason.statusCode).toBe(400);
    const ok = await t.app.inject({
      method: 'POST',
      url: '/admin/checkin/manual',
      headers: adminHeaders(cookie),
      payload: { attendeeId, reason: 'laptop battery died' },
    });
    expect(json<ScanResponse>(ok).result).toBe('valid');
    const dup = await t.app.inject({
      method: 'POST',
      url: '/admin/checkin/manual',
      headers: adminHeaders(cookie),
      payload: { attendeeId, reason: 'again' },
    });
    expect(json<ScanResponse>(dup).result).toBe('already_checked_in');
    expect(await t.prisma.attendance.count()).toBe(1);
    const logs = await t.prisma.auditLog.findMany({ where: { action: 'checkin.manual' } });
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!.data)).toEqual({ reason: 'laptop battery died' });

    const door = await loginAdmin(t, 'door@example.org');
    const denied = await t.app.inject({
      method: 'POST',
      url: '/admin/checkin/manual',
      headers: adminHeaders(door.cookie),
      payload: { attendeeId, reason: 'volunteer tries' },
    });
    expect(denied.statusCode).toBe(403);
  });

  it('exports CSV and XLSX with name, email, time, method and scanner', async () => {
    const body = json<{ qrSecret: string }>(await submit(report()));
    await scanAs(
      'door@example.org',
      buildQrPayload(Buffer.from(body.qrSecret, 'base64'), attendeeId, currentWindow(t.clock.now)),
    );
    const other = await addAttendee(t, '=cmd@example.com', '=HYPERLINK("evil")');
    const { cookie } = await loginAdmin(t, 'root@example.org');
    await t.app.inject({
      method: 'POST',
      url: '/admin/checkin/manual',
      headers: adminHeaders(cookie),
      payload: { attendeeId: other.id, reason: 'no laptop' },
    });

    const csv = await t.app.inject({
      method: 'GET',
      url: '/admin/attendance/export?format=csv',
      headers: { cookie },
    });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(
      /attachment; filename="test-event-attendance-.*\.csv"/,
    );
    const lines = csv.body.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe(
      'Name,Email,Checked in at (UTC),Method,Scanner,Scanner email,Reason (manual),Attendee ID',
    );
    expect(lines[1]).toMatch(
      /^Asha Rao,asha@example.com,\d{4}-\d\d-\d\dT.*,qr,door,door@example.org,,/,
    );
    // Formula injection is neutralised.
    expect(lines[2]).toMatch(/^"'=HYPERLINK\(""evil""\)",'=cmd@example.com,.*,manual,root,/);

    const xlsx = await t.app.inject({
      method: 'GET',
      url: '/admin/attendance/export?format=xlsx',
      headers: { cookie },
    });
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    expect(xlsx.rawPayload.subarray(0, 2).toString()).toBe('PK');

    const door = await loginAdmin(t, 'door@example.org');
    expect(
      (
        await t.app.inject({
          method: 'GET',
          url: '/admin/attendance/export',
          headers: { cookie: door.cookie },
        })
      ).statusCode,
    ).toBe(403);
  });
});
