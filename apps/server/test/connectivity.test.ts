import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  type ComplianceRow,
  type LogEntry,
  type LogEventType,
  type NetState,
} from '@eventkit/shared';
import { sealEntry } from '@eventkit/shared/node';
import {
  addAdmin,
  addAttendee,
  json,
  loginAdmin,
  loginAttendee,
  makeApp,
  type TestApp,
} from './helpers';

const MIN = 60_000;
let t: TestApp;
let token: string;
let key: Buffer;
let attendeeId: string;
let START: number;
let END: number;

beforeEach(async () => {
  t = await makeApp();
  await addAttendee(t, 'asha@example.com', 'Asha Rao');
  await addAdmin(t, 'root@example.org');
  const login = await loginAttendee(t, 'asha@example.com');
  token = login.token;
  key = Buffer.from(login.deviceKey, 'base64');
  attendeeId = login.attendee.id;
  START = t.clock.now - 60 * MIN;
  END = t.clock.now - 5 * MIN;
  const event = await t.app.ctx.event();
  await t.prisma.schedule.create({
    data: {
      eventId: event.id,
      startAt: new Date(START),
      endAt: new Date(END),
      mode: 'strict',
      graceSeconds: 120,
    },
  });
});
afterEach(async () => t.close());

type Step = { minute: number; type: LogEventType; state?: NetState };

/** Build a sealed, chained log; monotonic time tracks wall time. */
function buildLog(steps: Step[], logId: string = randomUUID()): LogEntry[] {
  let prevHash = GENESIS_HASH;
  return steps.map((s, seq) => {
    const wall = START + s.minute * MIN;
    const e = sealEntry(
      {
        logId,
        seq,
        wallTime: Math.round(wall),
        monoMs: 1_000_000 + (wall - START),
        bootId: 'boot-1',
        offsetMs: 0,
        type: s.type,
        data: s.state ? { state: s.state } : {},
        prevHash,
      },
      key,
    );
    prevHash = e.hash;
    return e;
  });
}

function offlineRun(from: number, to: number): Step[] {
  const out: Step[] = [];
  for (let m = from; m <= to; m++) out.push({ minute: m, type: 'heartbeat', state: 'offline' });
  return out;
}

const fullPhase = (): Step[] => [
  { minute: -5, type: 'app_start', state: 'online' },
  { minute: -4, type: 'offline' },
  ...offlineRun(-3, -1),
  { minute: 0, type: 'phase_start', state: 'offline' },
  ...offlineRun(1, 54),
  { minute: 55, type: 'phase_end', state: 'offline' },
  { minute: 56, type: 'online' },
];

const auth = () => ({ authorization: `Bearer ${token}` });
const uploadLog = (entries: LogEntry[]) =>
  t.app.inject({
    method: 'POST',
    url: '/api/connectivity/log',
    headers: auth(),
    payload: { logId: entries[0]!.logId, scheduleVersion: 1, entries },
  });
const sendEvents = (entries: LogEntry[]) =>
  t.app.inject({
    method: 'POST',
    url: '/api/connectivity/events',
    headers: auth(),
    payload: { entries },
  });

async function monitoringRow(): Promise<ComplianceRow> {
  const { cookie } = await loginAdmin(t, 'root@example.org');
  const res = await t.app.inject({ method: 'GET', url: '/admin/monitoring', headers: { cookie } });
  return json<{ rows: ComplianceRow[] }>(res).rows.find((r) => r.attendeeId === attendeeId)!;
}

describe('phase-2 connectivity', () => {
  it('marks a fully offline, verified log as compliant', async () => {
    const res = await uploadLog(buildLog(fullPhase()));
    expect(json(res)).toMatchObject({ chainValid: true, errors: [] });
    const row = await monitoringRow();
    expect(row.status).toBe('compliant');
    expect(row.logVerified).toBe(true);
    expect(row.totalOnlineSeconds).toBe(0);
  });

  it('shows a few seconds online live (before any log upload) as a violation', async () => {
    const log = buildLog([...fullPhase().slice(0, 20), { minute: 20.1, type: 'online' }]);
    const res = await sendEvents(log.slice(-1));
    expect(json(res)).toMatchObject({ accepted: 1, chainValid: true });
    const row = await monitoringRow();
    expect(row.status).toBe('violation');
    expect(row.flags).toContain('unverified');
    expect(row.onlineCount).toBe(1);
    expect(row.firstSeenOnline).toBe(new Date(START + 20.1 * MIN).toISOString());
  });

  it('finds a short online blip from the uploaded log after the phase', async () => {
    const steps = fullPhase();
    steps.splice(30, 0, { minute: 25.05, type: 'online' }, { minute: 25.1, type: 'offline' });
    const log = buildLog(steps.sort((a, b) => a.minute - b.minute));
    expect(json(await uploadLog(log))).toMatchObject({ chainValid: true });
    const row = await monitoringRow();
    expect(row.status).toBe('violation');
    expect(row.totalOnlineSeconds).toBe(3);
    expect(row.logVerified).toBe(true);
  });

  it('flags a log with a removed "online" entry as tampered', async () => {
    const steps = fullPhase();
    steps.splice(30, 0, { minute: 25.05, type: 'online' }, { minute: 25.1, type: 'offline' });
    const log = buildLog(steps.sort((a, b) => a.minute - b.minute));
    const idx = log.findIndex((e) => e.type === 'online' && e.wallTime > START);
    log.splice(idx, 1);
    const res = json<{ chainValid: boolean; errors: string[] }>(await uploadLog(log));
    expect(res.chainValid).toBe(false);
    expect(res.errors.join()).toMatch(/missing entries/);
    expect((await monitoringRow()).status).toBe('tampered');
  });

  it('flags an edited entry (hash mismatch) as tampered', async () => {
    const log = buildLog(fullPhase());
    log[10] = { ...log[10]!, data: { state: 'online' } };
    expect(json<{ chainValid: boolean }>(await uploadLog(log)).chainValid).toBe(false);
    expect((await monitoringRow()).status).toBe('tampered');
  });

  it('detects a log that omits an event already reported live', async () => {
    const steps = fullPhase();
    steps.splice(30, 0, { minute: 25.05, type: 'online' });
    const log = buildLog(steps.sort((a, b) => a.minute - b.minute));
    const onlineEntry = log.find((e) => e.type === 'online' && e.wallTime > START)!;
    await sendEvents([onlineEntry]);
    // Rebuild a "clean" log without the online entry (re-sealed so the chain itself is intact).
    const clean = buildLog(fullPhase(), log[0]!.logId);
    const res = json<{ chainValid: boolean; errors: string[] }>(await uploadLog(clean));
    expect(res.chainValid).toBe(false);
    expect((await monitoringRow()).status).toBe('tampered');
  });

  it('reports a monitoring gap when the app was quit mid-phase', async () => {
    const steps: Step[] = [
      { minute: -5, type: 'app_start', state: 'offline' },
      ...offlineRun(-4, 20),
      { minute: 20.5, type: 'app_stop' },
    ];
    const first = buildLog(steps);
    const second = buildLog([
      { minute: 40, type: 'app_start', state: 'offline' },
      ...offlineRun(41, 55),
      { minute: 56, type: 'online' },
    ]);
    await uploadLog(first);
    await uploadLog(second);
    const row = await monitoringRow();
    expect(row.status).toBe('monitoring_gap');
    expect(row.gapSeconds).toBe(19.5 * 60);
  });

  it('rejects entries signed with another key (realtime) and stores them flagged', async () => {
    const log = buildLog(fullPhase());
    const forged = sealEntry({ ...log[5]!, seq: 5 }, Buffer.alloc(32, 7));
    const res = json<{ chainValid: boolean; errors: string[] }>(await sendEvents([forged]));
    expect(res.chainValid).toBe(false);
    expect((await monitoringRow()).status).toBe('tampered');
  });

  it('is idempotent for repeated uploads and exports CSV', async () => {
    const log = buildLog(fullPhase());
    await uploadLog(log);
    await sendEvents(log.slice(0, 5));
    const again = json<{ accepted: number; chainValid: boolean }>(await uploadLog(log));
    expect(again).toMatchObject({ accepted: 0, chainValid: true });
    expect(await t.prisma.connectivityEvent.count()).toBe(log.length);

    const { cookie } = await loginAdmin(t, 'root@example.org');
    const csv = await t.app.inject({
      method: 'GET',
      url: '/admin/monitoring/export?format=csv',
      headers: { cookie },
    });
    expect(csv.body).toContain('Asha Rao,asha@example.com,Compliant');
    const feed = await t.app.inject({
      method: 'GET',
      url: '/admin/monitoring/feed?limit=10',
      headers: { cookie },
    });
    expect(json<{ items: unknown[] }>(feed).items.length).toBeGreaterThan(0);
  });

  it('handles a realtime flush racing a full log upload', async () => {
    const log = buildLog(fullPhase());
    const live = Array.from({ length: 6 }, (_, i) => sendEvents(log.slice(i * 10, i * 10 + 10)));
    const results = await Promise.all([...live.slice(0, 3), uploadLog(log), ...live.slice(3)]);
    expect(results.map((r) => r.statusCode)).toEqual(results.map(() => 200));
    expect(await t.prisma.connectivityEvent.count()).toBe(log.length);
    expect((await monitoringRow()).status).toBe('compliant');
  });

  it('requires attendee auth', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/connectivity/events',
      payload: { entries: [] },
    });
    expect(res.statusCode).toBe(401);
  });
});
