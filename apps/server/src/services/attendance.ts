import { Prisma, type AdminUser } from '@prisma/client';
import type { AttendanceRow, ScanResponse } from '@eventkit/shared';
import { checkQrCode, parseQrPayload } from '@eventkit/shared/node';
import type { AppContext } from '../context';
import { notFound } from '../lib/errors';
import { audit } from './audit';
import { publishCounters } from './counters';

const MESSAGES: Record<ScanResponse['result'], string> = {
  valid: 'Checked in',
  already_checked_in: 'Already checked in',
  not_ready: 'Laptop setup not complete',
  expired: 'QR code expired: ask them to refresh the app',
  invalid: 'Invalid QR code',
};

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function existing(ctx: AppContext, attendeeId: string) {
  return ctx.prisma.attendance.findUnique({
    where: { attendeeId },
    include: { scanner: { select: { name: true, email: true } } },
  });
}

/**
 * Validate a scanned QR payload and check the attendee in.
 * Idempotent: the Attendance row is unique per attendee, so concurrent or
 * repeated scans never create a second record.
 */
export async function scan(ctx: AppContext, payload: string, scanner: AdminUser, ip: string): Promise<ScanResponse> {
  const now = ctx.now();
  const respond = async (
    result: ScanResponse['result'],
    attendee: { id: string; name: string; email: string } | null,
    extra: Partial<ScanResponse> = {},
  ): Promise<ScanResponse> => {
    await audit(ctx.prisma, {
      actorType: 'admin',
      actorId: scanner.id,
      actorLabel: scanner.email,
      action: `scan.${result}`,
      target: attendee?.id ?? null,
      ip,
    });
    return { result, message: MESSAGES[result], attendee, checkedInAt: null, checkedInBy: null, ...extra };
  };

  const qr = parseQrPayload(payload);
  if (!qr) return respond('invalid', null);
  const event = await ctx.event();
  const a = await ctx.prisma.attendee.findUnique({ where: { id: qr.attendeeId } });
  if (!a || a.eventId !== event.id) return respond('invalid', null);
  const who = { id: a.id, name: a.name, email: a.email };
  if (!a.qrSecret) return respond('not_ready', who);

  const check = checkQrCode(Buffer.from(a.qrSecret, 'base64'), qr, now);
  if (check === 'invalid') return respond('invalid', null);

  const prior = await existing(ctx, a.id);
  if (prior) {
    return respond('already_checked_in', who, {
      checkedInAt: prior.checkedInAt.toISOString(),
      checkedInBy: prior.scanner?.name ?? (prior.method === 'manual' ? 'manual' : null),
    });
  }
  if (check === 'expired') return respond('expired', who);
  if (a.status !== 'ready') return respond('not_ready', who);

  try {
    const row = await ctx.prisma.attendance.create({
      data: { eventId: event.id, attendeeId: a.id, method: 'qr', scannerId: scanner.id, checkedInAt: new Date(now) },
    });
    ctx.hub.publish({ type: 'checkin', data: { attendeeId: a.id, name: a.name, method: 'qr', at: row.checkedInAt.toISOString() } });
    publishCounters(ctx);
    return respond('valid', who, { checkedInAt: row.checkedInAt.toISOString(), checkedInBy: scanner.name });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const again = await existing(ctx, a.id);
    return respond('already_checked_in', who, {
      checkedInAt: again?.checkedInAt.toISOString() ?? null,
      checkedInBy: again?.scanner?.name ?? null,
    });
  }
}

/** Manual check-in (e.g. broken laptop), with a mandatory reason. */
export async function manualCheckin(
  ctx: AppContext,
  attendeeId: string,
  reason: string,
  admin: AdminUser,
  ip: string,
): Promise<ScanResponse> {
  const event = await ctx.event();
  const a = await ctx.prisma.attendee.findUnique({ where: { id: attendeeId } });
  if (!a || a.eventId !== event.id) throw notFound('Attendee not found');
  const who = { id: a.id, name: a.name, email: a.email };
  const prior = await existing(ctx, a.id);
  if (prior) {
    return {
      result: 'already_checked_in',
      message: MESSAGES.already_checked_in,
      attendee: who,
      checkedInAt: prior.checkedInAt.toISOString(),
      checkedInBy: prior.scanner?.name ?? null,
    };
  }
  let row;
  try {
    row = await ctx.prisma.attendance.create({
      data: { eventId: event.id, attendeeId: a.id, method: 'manual', scannerId: admin.id, reason, checkedInAt: new Date(ctx.now()) },
    });
  } catch (err) {
    if (isUniqueViolation(err)) return manualCheckin(ctx, attendeeId, reason, admin, ip);
    throw err;
  }
  await audit(ctx.prisma, {
    actorType: 'admin',
    actorId: admin.id,
    actorLabel: admin.email,
    action: 'checkin.manual',
    target: a.id,
    data: { reason },
    ip,
  });
  ctx.hub.publish({ type: 'checkin', data: { attendeeId: a.id, name: a.name, method: 'manual', at: row.checkedInAt.toISOString() } });
  publishCounters(ctx);
  return { result: 'valid', message: 'Checked in manually', attendee: who, checkedInAt: row.checkedInAt.toISOString(), checkedInBy: admin.name };
}

export async function attendanceRows(ctx: AppContext): Promise<AttendanceRow[]> {
  const event = await ctx.event();
  const rows = await ctx.prisma.attendance.findMany({
    where: { eventId: event.id },
    include: { attendee: true, scanner: true },
    orderBy: { checkedInAt: 'asc' },
  });
  return rows.map((r) => ({
    attendeeId: r.attendeeId,
    name: r.attendee.name,
    email: r.attendee.email,
    checkedInAt: r.checkedInAt.toISOString(),
    method: r.method as 'qr' | 'manual',
    scannerName: r.scanner?.name ?? null,
    scannerEmail: r.scanner?.email ?? null,
    reason: r.reason,
  }));
}
