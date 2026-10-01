import type { Attendee, Device } from '@prisma/client';
import type { ConnectivityAck, LogEntry } from '@eventkit/shared';
import { verifyChain, verifyEntry } from '@eventkit/shared/node';
import type { AppContext } from '../context';
import { audit } from './audit';
import { invalidateCompliance } from './compliance';
import { publishCounters } from './counters';
import { KeyedMutex } from '../lib/util';

/** Realtime and full-log uploads from one device may race; ingest them one at a time. */
const deviceLock = new KeyedMutex();

const NOTABLE = new Set([
  'online',
  'limited',
  'offline',
  'app_start',
  'app_stop',
  'phase_start',
  'phase_end',
  'clock_anomaly',
  'suspend',
  'resume',
]);

function row(
  attendee: Attendee,
  device: Device,
  e: LogEntry,
  source: 'realtime' | 'uploaded_log',
  valid: boolean,
) {
  return {
    attendeeId: attendee.id,
    deviceId: device.id,
    logId: e.logId,
    seq: e.seq,
    type: e.type,
    wallTime: new Date(e.wallTime),
    monoMs: e.monoMs,
    bootId: e.bootId,
    offsetMs: e.offsetMs,
    data: JSON.stringify(e.data),
    prevHash: e.prevHash,
    hash: e.hash,
    hmac: e.hmac,
    source,
    valid,
  };
}

function publish(
  ctx: AppContext,
  attendee: Attendee,
  device: Device,
  e: LogEntry,
  source: 'realtime' | 'uploaded_log',
) {
  if (!NOTABLE.has(e.type)) return;
  ctx.hub.publish({
    type: 'connectivity',
    data: {
      attendeeId: attendee.id,
      name: attendee.name,
      deviceId: device.id,
      eventType: e.type,
      state: e.data.state,
      at: new Date(e.wallTime + e.offsetMs).toISOString(),
      source,
    },
  });
}

/**
 * Real-time events sent while the laptop is online (which during phase 2 is
 * itself the evidence of a violation). Each entry's hash + HMAC is checked;
 * invalid ones are stored flagged so tampering stays visible.
 */
export function ingestRealtime(
  ctx: AppContext,
  attendee: Attendee,
  device: Device,
  entries: LogEntry[],
): Promise<ConnectivityAck> {
  return deviceLock.run(device.id, () => ingestRealtimeLocked(ctx, attendee, device, entries));
}

async function ingestRealtimeLocked(
  ctx: AppContext,
  attendee: Attendee,
  device: Device,
  entries: LogEntry[],
): Promise<ConnectivityAck> {
  const key = Buffer.from(device.deviceKey, 'base64');
  const errors: string[] = [];
  let accepted = 0;
  let lastSeq: number | null = null;
  for (const e of entries) {
    const err = verifyEntry(e, key);
    if (err) errors.push(err);
    const exists = await ctx.prisma.connectivityEvent.findUnique({
      where: { deviceId_logId_seq: { deviceId: device.id, logId: e.logId, seq: e.seq } },
      select: { hash: true },
    });
    if (exists) {
      if (exists.hash !== e.hash) errors.push(`seq ${e.seq}: conflicts with an earlier copy`);
    } else {
      await ctx.prisma.connectivityEvent.create({
        data: row(attendee, device, e, 'realtime', !err),
      });
      accepted++;
      publish(ctx, attendee, device, e, 'realtime');
    }
    lastSeq = Math.max(lastSeq ?? -1, e.seq);
  }
  if (accepted > 0) {
    invalidateCompliance();
    publishCounters(ctx);
  }
  return { accepted, chainValid: errors.length === 0, errors, lastSeq };
}

/**
 * Full log upload (after the phase, or whenever the device is back online).
 * Verifies the complete hash chain, merges with realtime copies (a mismatch
 * between the two is tampering) and records the verification result.
 */
export function ingestLog(
  ctx: AppContext,
  attendee: Attendee,
  device: Device,
  body: { logId: string; scheduleVersion: number; entries: LogEntry[] },
  ip: string,
): Promise<ConnectivityAck> {
  return deviceLock.run(device.id, () => ingestLogLocked(ctx, attendee, device, body, ip));
}

async function ingestLogLocked(
  ctx: AppContext,
  attendee: Attendee,
  device: Device,
  body: { logId: string; scheduleVersion: number; entries: LogEntry[] },
  ip: string,
): Promise<ConnectivityAck> {
  const key = Buffer.from(device.deviceKey, 'base64');
  const entries = body.entries.filter((e) => e.logId === body.logId);
  const chain = verifyChain(entries, key);
  const errors = [...chain.errors];
  if (entries.length !== body.entries.length) errors.push('entries from another log were included');

  const existing = await ctx.prisma.connectivityEvent.findMany({
    where: { deviceId: device.id, logId: body.logId },
    select: { seq: true, hash: true, source: true },
  });
  const bySeq = new Map(existing.map((x) => [x.seq, x]));
  const incoming = new Set(entries.map((e) => e.seq));
  // Entries newer than this upload (sent live after the snapshot) are fine; older ones must be present.
  const maxSeq = chain.lastSeq ?? -1;
  for (const x of existing) {
    if (x.seq <= maxSeq && !incoming.has(x.seq)) {
      errors.push(`seq ${x.seq} was reported live but is missing from the log`);
    }
  }

  const toCreate: ReturnType<typeof row>[] = [];
  const toPromote: number[] = [];
  let accepted = 0;
  for (const e of entries) {
    const prior = bySeq.get(e.seq);
    if (!prior) {
      toCreate.push(row(attendee, device, e, 'uploaded_log', verifyEntry(e, key) === null));
      accepted++;
    } else if (prior.hash !== e.hash) {
      errors.push(`seq ${e.seq}: differs from the copy sent live`);
    } else if (prior.source !== 'uploaded_log') {
      toPromote.push(e.seq);
    }
  }
  for (let i = 0; i < toCreate.length; i += 500) {
    await ctx.prisma.connectivityEvent.createMany({ data: toCreate.slice(i, i + 500) });
  }
  if (toPromote.length) {
    await ctx.prisma.connectivityEvent.updateMany({
      where: { deviceId: device.id, logId: body.logId, seq: { in: toPromote } },
      data: { source: 'uploaded_log' },
    });
  }

  const times = entries.map((e) => e.wallTime + e.offsetMs);
  const chainValid = errors.length === 0;
  const data = {
    attendeeId: attendee.id,
    scheduleVersion: body.scheduleVersion,
    entryCount: entries.length,
    lastSeq: chain.lastSeq,
    firstEntryAt: times.length ? new Date(Math.min(...times)) : null,
    lastEntryAt: times.length ? new Date(Math.max(...times)) : null,
    chainValid,
    errors: JSON.stringify(errors.slice(0, 50)),
    clockAnomalies: JSON.stringify(chain.clockAnomalies.slice(0, 50)),
    uploadedAt: new Date(ctx.now()),
  };
  const prev = await ctx.prisma.connectivityLog.findUnique({
    where: { deviceId_logId: { deviceId: device.id, logId: body.logId } },
  });
  // A log that was ever found tampered stays tampered.
  if (prev && !prev.chainValid) {
    data.chainValid = false;
    data.errors = JSON.stringify(
      [...(JSON.parse(prev.errors) as string[]), ...errors].slice(0, 50),
    );
  }
  await ctx.prisma.connectivityLog.upsert({
    where: { deviceId_logId: { deviceId: device.id, logId: body.logId } },
    create: { deviceId: device.id, logId: body.logId, ...data },
    update: data,
  });

  for (const e of entries.slice(-20))
    if (!bySeq.has(e.seq)) publish(ctx, attendee, device, e, 'uploaded_log');
  await audit(ctx.prisma, {
    actorType: 'attendee',
    actorId: attendee.id,
    action: data.chainValid ? 'connectivity.log_verified' : 'connectivity.log_tampered',
    target: device.id,
    data: { logId: body.logId, entries: entries.length, errors: errors.slice(0, 5) },
    ip,
  });
  invalidateCompliance();
  publishCounters(ctx);
  return { accepted, chainValid: data.chainValid, errors, lastSeq: chain.lastSeq };
}
