import type { Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AttendeeListQuerySchema,
  AttendeeUpsertBodySchema,
  type AttendeeListResponse,
  type AttendeeStatus,
} from '@eventkit/shared';
import { conflict, notFound, parse } from '../../lib/errors';
import { containsCI, iso, jsonParse } from '../../lib/util';
import { requireAdmin } from '../../plugins/auth';
import { audit } from '../../services/audit';
import { computeCompliance } from '../../services/compliance';
import { publishCounters } from '../../services/counters';
import { importRsvpCsv } from '../../services/rsvp-import';

const ImportBodySchema = z.object({ csv: z.string().min(1).max(5_000_000) });

export async function adminAttendeeRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const superadmin = requireAdmin('superadmin');
  const anyAdmin = requireAdmin();

  app.get(
    '/admin/attendees',
    { preHandler: superadmin },
    async (req): Promise<AttendeeListResponse> => {
      const q = parse(AttendeeListQuerySchema, req.query);
      const event = await ctx.event();
      const where: Prisma.AttendeeWhereInput = { eventId: event.id };
      if (q.q) {
        where.OR = [
          { email: containsCI(ctx.env.DATABASE_URL, q.q.toLowerCase()) },
          { name: containsCI(ctx.env.DATABASE_URL, q.q) },
        ];
      }
      if (q.status === 'checked_in') where.attendance = { isNot: null };
      else if (q.status && q.status !== 'all') where.status = q.status;

      const [total, rows, compliance] = await Promise.all([
        ctx.prisma.attendee.count({ where }),
        ctx.prisma.attendee.findMany({
          where,
          include: {
            attendance: true,
            devices: { select: { overallPercent: true, lastSeenAt: true } },
          },
          orderBy: [{ name: 'asc' }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
        computeCompliance(ctx),
      ]);
      const compById = new Map(compliance.map((c) => [c.attendeeId, c]));
      return {
        total,
        page: q.page,
        pageSize: q.pageSize,
        items: rows.map((a) => {
          const c = compById.get(a.id);
          return {
            id: a.id,
            email: a.email,
            name: a.name,
            status: a.status as AttendeeStatus,
            checkedInAt: iso(a.attendance?.checkedInAt),
            lastSeenAt: iso(a.lastSeenAt),
            overallPercent: a.devices.reduce<number | null>(
              (m, d) => (d.overallPercent == null ? m : Math.max(m ?? 0, d.overallPercent)),
              null,
            ),
            deviceCount: a.devices.length,
            compliance: c && c.deviceId ? c.status : null,
          };
        }),
      };
    },
  );

  /** Minimal search used by the scanner's manual lookup (volunteers allowed). */
  app.get('/admin/attendees/search', { preHandler: anyAdmin }, async (req) => {
    const { q } = parse(z.object({ q: z.string().trim().min(2).max(100) }), req.query);
    const event = await ctx.event();
    const rows = await ctx.prisma.attendee.findMany({
      where: {
        eventId: event.id,
        OR: [
          { email: containsCI(ctx.env.DATABASE_URL, q.toLowerCase()) },
          { name: containsCI(ctx.env.DATABASE_URL, q) },
        ],
      },
      include: { attendance: true },
      take: 20,
      orderBy: { name: 'asc' },
    });
    return {
      items: rows.map((a) => ({
        id: a.id,
        name: a.name,
        email: a.email,
        status: a.status,
        checkedInAt: iso(a.attendance?.checkedInAt),
      })),
    };
  });

  app.get<{ Params: { id: string } }>(
    '/admin/attendees/:id',
    { preHandler: superadmin },
    async (req) => {
      const a = await ctx.prisma.attendee.findUnique({
        where: { id: req.params.id },
        include: {
          attendance: { include: { scanner: { select: { name: true, email: true } } } },
          devices: { orderBy: { lastSeenAt: 'desc' } },
          setupProgress: { orderBy: { componentId: 'asc' } },
          readinessReports: { orderBy: { createdAt: 'desc' }, take: 5 },
        },
      });
      if (!a) throw notFound('Attendee not found');
      const [events, logs, compliance] = await Promise.all([
        ctx.prisma.connectivityEvent.findMany({
          where: { attendeeId: a.id },
          orderBy: { wallTime: 'desc' },
          take: 300,
        }),
        ctx.prisma.connectivityLog.findMany({
          where: { attendeeId: a.id },
          orderBy: { uploadedAt: 'desc' },
        }),
        computeCompliance(ctx),
      ]);
      return {
        attendee: {
          id: a.id,
          email: a.email,
          name: a.name,
          status: a.status,
          readyAt: iso(a.readyAt),
          lastSeenAt: iso(a.lastSeenAt),
          createdAt: a.createdAt.toISOString(),
          hasQrSecret: Boolean(a.qrSecret),
        },
        attendance: a.attendance
          ? {
              checkedInAt: a.attendance.checkedInAt.toISOString(),
              method: a.attendance.method,
              reason: a.attendance.reason,
              scanner: a.attendance.scanner,
            }
          : null,
        devices: a.devices.map((d) => ({
          id: d.id,
          os: d.os,
          arch: d.arch,
          osVersion: d.osVersion,
          hostname: d.hostname,
          appVersion: d.appVersion,
          overallPercent: d.overallPercent,
          firstSeenAt: d.firstSeenAt.toISOString(),
          lastSeenAt: d.lastSeenAt.toISOString(),
        })),
        progress: a.setupProgress.map((p) => ({
          deviceId: p.deviceId,
          componentId: p.componentId,
          status: p.status,
          step: p.step,
          version: p.version,
          percent: p.percent,
          message: p.message,
          updatedAt: p.updatedAt.toISOString(),
        })),
        readiness: a.readinessReports.map((r) => ({
          id: r.id,
          deviceId: r.deviceId,
          accepted: r.accepted,
          reasons: jsonParse<string[]>(r.reasons, []),
          report: jsonParse<unknown>(r.report, null),
          createdAt: r.createdAt.toISOString(),
        })),
        connectivity: events.map((e) => ({
          id: e.id,
          deviceId: e.deviceId,
          seq: e.seq,
          type: e.type,
          at: new Date(e.wallTime.getTime() + e.offsetMs).toISOString(),
          data: jsonParse<unknown>(e.data, {}),
          source: e.source,
          valid: e.valid,
        })),
        logs: logs.map((l) => ({
          deviceId: l.deviceId,
          logId: l.logId,
          entryCount: l.entryCount,
          chainValid: l.chainValid,
          errors: jsonParse<string[]>(l.errors, []),
          uploadedAt: l.uploadedAt.toISOString(),
          lastEntryAt: iso(l.lastEntryAt),
        })),
        compliance: compliance.find((c) => c.attendeeId === a.id) ?? null,
      };
    },
  );

  app.post('/admin/attendees', { preHandler: superadmin }, async (req) => {
    const body = parse(AttendeeUpsertBodySchema, req.body);
    const event = await ctx.event();
    const exists = await ctx.prisma.attendee.findUnique({
      where: { eventId_email: { eventId: event.id, email: body.email } },
    });
    if (exists) throw conflict('duplicate_email', 'An attendee with this email already exists');
    const a = await ctx.prisma.attendee.create({ data: { eventId: event.id, ...body } });
    await audit(ctx.prisma, {
      actorType: 'admin',
      actorId: req.admin!.id,
      actorLabel: req.admin!.email,
      action: 'attendee.create',
      target: a.id,
      data: { email: a.email },
      ip: req.ip,
    });
    publishCounters(ctx);
    return { id: a.id };
  });

  app.patch<{ Params: { id: string } }>(
    '/admin/attendees/:id',
    { preHandler: superadmin },
    async (req) => {
      const body = parse(AttendeeUpsertBodySchema.partial(), req.body);
      const a = await ctx.prisma.attendee
        .update({ where: { id: req.params.id }, data: body })
        .catch(() => null);
      if (!a) throw notFound('Attendee not found');
      await audit(ctx.prisma, {
        actorType: 'admin',
        actorId: req.admin!.id,
        actorLabel: req.admin!.email,
        action: 'attendee.update',
        target: a.id,
        data: body,
        ip: req.ip,
      });
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/attendees/:id',
    { preHandler: superadmin },
    async (req) => {
      const a = await ctx.prisma.attendee
        .delete({ where: { id: req.params.id } })
        .catch(() => null);
      if (!a) throw notFound('Attendee not found');
      await audit(ctx.prisma, {
        actorType: 'admin',
        actorId: req.admin!.id,
        actorLabel: req.admin!.email,
        action: 'attendee.delete',
        target: a.id,
        data: { email: a.email },
        ip: req.ip,
      });
      publishCounters(ctx);
      return { ok: true };
    },
  );

  /** Revoke the attendee's QR secret; they must pass readiness again. */
  app.post<{ Params: { id: string } }>(
    '/admin/attendees/:id/revoke-qr',
    { preHandler: superadmin },
    async (req) => {
      const a = await ctx.prisma.attendee
        .update({
          where: { id: req.params.id },
          data: { qrSecret: null, status: 'not_ready', readyAt: null },
        })
        .catch(() => null);
      if (!a) throw notFound('Attendee not found');
      await audit(ctx.prisma, {
        actorType: 'admin',
        actorId: req.admin!.id,
        actorLabel: req.admin!.email,
        action: 'attendee.revoke_qr',
        target: a.id,
        ip: req.ip,
      });
      publishCounters(ctx);
      return { ok: true };
    },
  );

  app.post(
    '/admin/attendees/import',
    { preHandler: superadmin, bodyLimit: 6_000_000 },
    async (req) => {
      const { csv } = parse(ImportBodySchema, req.body);
      const result = await importRsvpCsv(ctx, csv);
      await audit(ctx.prisma, {
        actorType: 'admin',
        actorId: req.admin!.id,
        actorLabel: req.admin!.email,
        action: 'attendee.import',
        data: {
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          duplicates: result.duplicates,
        },
        ip: req.ip,
      });
      publishCounters(ctx);
      return result;
    },
  );
}
