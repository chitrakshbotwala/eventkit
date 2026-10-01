import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ComplianceRow } from '@eventkit/shared';
import { parse } from '../../lib/errors';
import { jsonParse } from '../../lib/util';
import { requireAdmin } from '../../plugins/auth';
import { audit } from '../../services/audit';
import { computeCompliance } from '../../services/compliance';
import { toCsv, toXlsx, type Column } from '../../services/export';
import { getSchedule, scheduleDto } from '../../services/schedule';

const LABELS: Record<ComplianceRow['status'], string> = {
  compliant: 'Compliant',
  violation: 'Violation',
  warning: 'Warning',
  unverified: 'Unverified',
  monitoring_gap: 'Monitoring gap',
  tampered: 'Tampered chain',
};

const COLUMNS: Column<ComplianceRow>[] = [
  { header: 'Name', width: 28, value: (r) => r.name },
  { header: 'Email', width: 32, value: (r) => r.email },
  { header: 'Status', width: 16, value: (r) => LABELS[r.status] },
  { header: 'Flags', width: 30, value: (r) => r.flags.map((f) => LABELS[f]).join(', ') },
  { header: 'First seen online (UTC)', width: 24, value: (r) => r.firstSeenOnline },
  { header: 'Total online seconds', width: 12, value: (r) => r.totalOnlineSeconds },
  { header: 'Online count', width: 10, value: (r) => r.onlineCount },
  { header: 'Interface-only seconds', width: 12, value: (r) => r.limitedSeconds },
  { header: 'Monitoring gap seconds', width: 12, value: (r) => r.gapSeconds },
  { header: 'Last event (UTC)', width: 24, value: (r) => r.lastEventAt },
  { header: 'Log verified', width: 10, value: (r) => (r.logVerified ? 'yes' : 'no') },
  { header: 'Notes', width: 50, value: (r) => r.notes.join('; ') },
];

export async function adminMonitoringRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const superadmin = requireAdmin('superadmin');

  app.get('/admin/monitoring', { preHandler: superadmin }, async () => ({
    schedule: scheduleDto(await getSchedule(ctx)),
    serverTime: ctx.now(),
    rows: await computeCompliance(ctx, { fresh: true }),
  }));

  app.get('/admin/monitoring/feed', { preHandler: superadmin }, async (req) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200) }), req.query);
    const event = await ctx.event();
    const rows = await ctx.prisma.connectivityEvent.findMany({
      where: { attendee: { eventId: event.id }, type: { not: 'heartbeat' } },
      orderBy: { receivedAt: 'desc' },
      take: limit,
      include: { attendee: { select: { name: true } } },
    });
    return {
      items: rows.map((e) => ({
        id: e.id,
        attendeeId: e.attendeeId,
        name: e.attendee.name,
        deviceId: e.deviceId,
        type: e.type,
        state: jsonParse<{ state?: string }>(e.data, {}).state,
        at: new Date(e.wallTime.getTime() + e.offsetMs).toISOString(),
        source: e.source as 'realtime' | 'uploaded_log',
        valid: e.valid,
      })),
    };
  });

  app.get('/admin/monitoring/export', { preHandler: superadmin }, async (req, reply) => {
    const { format } = parse(z.object({ format: z.enum(['csv', 'xlsx']).default('csv') }), req.query);
    const rows = await computeCompliance(ctx, { fresh: true });
    const event = await ctx.event();
    const base = `${event.slug}-phase2-compliance-${new Date(ctx.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
    await audit(ctx.prisma, {
      actorType: 'admin',
      actorId: req.admin!.id,
      actorLabel: req.admin!.email,
      action: 'monitoring.export',
      data: { format, rows: rows.length },
      ip: req.ip,
    });
    if (format === 'xlsx') {
      reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="${base}.xlsx"`);
      return reply.send(await toXlsx(rows, COLUMNS, 'Compliance'));
    }
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${base}.csv"`);
    return reply.send(toCsv(rows, COLUMNS));
  });
}
