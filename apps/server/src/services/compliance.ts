import {
  evaluateCompliance,
  gapThresholdMs,
  type ComplianceRow,
  type NetState,
  type PhaseMode,
  type PolicyEntry,
} from '@eventkit/shared';
import type { AppContext } from '../context';
import { jsonParse } from '../lib/util';
import { getSchedule } from './schedule';

const MARGIN_MS = 30 * 60_000;

let cache: { at: number; version: number; rows: ComplianceRow[] } | null = null;

export function invalidateCompliance() {
  cache = null;
}

/** Compute per-attendee phase-2 compliance for the current schedule window. */
export async function computeCompliance(
  ctx: AppContext,
  opts: { fresh?: boolean } = {},
): Promise<ComplianceRow[]> {
  const schedule = await getSchedule(ctx);
  const now = ctx.now();
  if (!opts.fresh && cache && cache.version === schedule.version && now - cache.at < 5_000)
    return cache.rows;

  const event = await ctx.event();
  const attendees = await ctx.prisma.attendee.findMany({
    where: { eventId: event.id },
    select: {
      id: true,
      name: true,
      email: true,
      devices: { select: { id: true, lastSeenAt: true } },
    },
    orderBy: { name: 'asc' },
  });

  if (!schedule.startAt || !schedule.endAt || schedule.startAt.getTime() > now) {
    const rows = attendees.map((a) =>
      emptyRow(a, schedule.startAt ? 'phase not started' : 'no phase scheduled'),
    );
    cache = { at: now, version: schedule.version, rows };
    return rows;
  }

  const startAt = schedule.startAt.getTime();
  const endAt = schedule.endAt.getTime();
  const [events, logs] = await Promise.all([
    ctx.prisma.connectivityEvent.findMany({
      where: {
        attendee: { eventId: event.id },
        wallTime: { gte: new Date(startAt - MARGIN_MS), lte: new Date(endAt + MARGIN_MS) },
      },
      select: {
        attendeeId: true,
        deviceId: true,
        logId: true,
        seq: true,
        type: true,
        wallTime: true,
        monoMs: true,
        bootId: true,
        offsetMs: true,
        data: true,
        source: true,
        valid: true,
      },
    }),
    ctx.prisma.connectivityLog.findMany({
      where: {
        attendee: { eventId: event.id },
        lastEntryAt: { gte: new Date(startAt - MARGIN_MS) },
      },
    }),
  ]);

  const byAttendee = new Map<string, typeof events>();
  for (const e of events) {
    const list = byAttendee.get(e.attendeeId) ?? [];
    list.push(e);
    byAttendee.set(e.attendeeId, list);
  }
  const logsByAttendee = new Map<string, typeof logs>();
  for (const l of logs) {
    const list = logsByAttendee.get(l.attendeeId) ?? [];
    list.push(l);
    logsByAttendee.set(l.attendeeId, list);
  }
  const threshold = gapThresholdMs(schedule.heartbeatSeconds);

  const rows = attendees.map((a): ComplianceRow => {
    const evs = byAttendee.get(a.id) ?? [];
    const aLogs = logsByAttendee.get(a.id) ?? [];
    if (a.devices.length === 0) return emptyRow(a, 'never signed in on a laptop');
    const entries: PolicyEntry[] = evs.map((e) => ({
      logId: e.logId,
      seq: e.seq,
      time: e.wallTime.getTime() + e.offsetMs,
      monoMs: e.monoMs,
      bootId: e.bootId,
      type: e.type as PolicyEntry['type'],
      state: jsonParse<{ state?: NetState }>(e.data, {}).state,
      source: e.source as PolicyEntry['source'],
    }));
    // Clock jumps detected server-side (wall vs monotonic) count like logged clock anomalies.
    const serverAnomalies: string[] = [];
    for (const l of aLogs) {
      for (const an of jsonParse<Array<{ seq: number; reason: string }>>(l.clockAnomalies, [])) {
        const at = entries.find((x) => x.logId === l.logId && x.seq === an.seq);
        if (!at) continue;
        entries.push({ ...at, seq: at.seq + 0.5, type: 'clock_anomaly', state: undefined });
        serverAnomalies.push(an.reason);
      }
    }
    const tampered = evs.some((e) => !e.valid) || aLogs.some((l) => !l.chainValid);
    const logVerified = aLogs.some(
      (l) => l.chainValid && l.lastEntryAt && l.lastEntryAt.getTime() >= endAt - threshold,
    );
    const r = evaluateCompliance({
      window: {
        startAt,
        endAt,
        graceSeconds: schedule.graceSeconds,
        mode: schedule.mode as PhaseMode,
        heartbeatSeconds: schedule.heartbeatSeconds,
      },
      entries,
      logVerified,
      tampered,
      now,
    });
    const notes = [...r.notes];
    for (const l of aLogs)
      if (!l.chainValid) notes.push(...jsonParse<string[]>(l.errors, []).slice(0, 3));
    if (serverAnomalies.length) notes.push(`clock: ${serverAnomalies[0]}`);
    if (a.devices.length > 1) notes.push(`${a.devices.length} devices`);
    return {
      attendeeId: a.id,
      name: a.name,
      email: a.email,
      deviceId: evs[0]?.deviceId ?? a.devices[0]?.id ?? null,
      status: r.status,
      flags: r.flags,
      firstSeenOnline: r.firstSeenOnline ? new Date(r.firstSeenOnline).toISOString() : null,
      totalOnlineSeconds: Math.round(r.totalOnlineSeconds),
      onlineCount: r.onlineCount,
      limitedSeconds: Math.round(r.limitedSeconds),
      gapSeconds: Math.round(r.gapSeconds),
      lastEventAt: r.lastEventAt ? new Date(r.lastEventAt).toISOString() : null,
      logVerified,
      notes,
    };
  });
  cache = { at: now, version: schedule.version, rows };
  return rows;
}

function emptyRow(a: { id: string; name: string; email: string }, note: string): ComplianceRow {
  return {
    attendeeId: a.id,
    name: a.name,
    email: a.email,
    deviceId: null,
    status: 'unverified',
    flags: ['unverified'],
    firstSeenOnline: null,
    totalOnlineSeconds: 0,
    onlineCount: 0,
    limitedSeconds: 0,
    gapSeconds: 0,
    lastEventAt: null,
    logVerified: false,
    notes: [note],
  };
}
