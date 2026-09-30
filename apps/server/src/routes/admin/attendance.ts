import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ManualCheckinBodySchema, ScanBodySchema, type AttendanceRow } from '@eventkit/shared';
import { parse } from '../../lib/errors';
import { requireAdmin } from '../../plugins/auth';
import { attendanceRows, manualCheckin, scan } from '../../services/attendance';
import { audit } from '../../services/audit';
import { toCsv, toXlsx, type Column } from '../../services/export';

const COLUMNS: Column<AttendanceRow>[] = [
  { header: 'Name', width: 28, value: (r) => r.name },
  { header: 'Email', width: 32, value: (r) => r.email },
  { header: 'Checked in at (UTC)', width: 24, value: (r) => r.checkedInAt },
  { header: 'Method', width: 10, value: (r) => r.method },
  { header: 'Scanner', width: 22, value: (r) => r.scannerName },
  { header: 'Scanner email', width: 28, value: (r) => r.scannerEmail },
  { header: 'Reason (manual)', width: 30, value: (r) => r.reason },
  { header: 'Attendee ID', width: 28, value: (r) => r.attendeeId },
];

export async function adminAttendanceRoutes(app: FastifyInstance) {
  const { ctx } = app;

  app.post(
    '/admin/scan',
    { preHandler: requireAdmin('superadmin', 'volunteer'), config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req) => {
      const { payload } = parse(ScanBodySchema, req.body);
      return scan(ctx, payload, req.admin!, req.ip);
    },
  );

  app.post('/admin/checkin/manual', { preHandler: requireAdmin('superadmin') }, async (req) => {
    const body = parse(ManualCheckinBodySchema, req.body);
    return manualCheckin(ctx, body.attendeeId, body.reason, req.admin!, req.ip);
  });

  app.get('/admin/attendance', { preHandler: requireAdmin() }, async () => ({ items: await attendanceRows(ctx) }));

  app.get('/admin/attendance/export', { preHandler: requireAdmin('superadmin') }, async (req, reply) => {
    const { format } = parse(z.object({ format: z.enum(['csv', 'xlsx']).default('csv') }), req.query);
    const rows = await attendanceRows(ctx);
    const event = await ctx.event();
    const stamp = new Date(ctx.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const base = `${event.slug}-attendance-${stamp}`;
    await audit(ctx.prisma, {
      actorType: 'admin',
      actorId: req.admin!.id,
      actorLabel: req.admin!.email,
      action: 'attendance.export',
      data: { format, rows: rows.length },
      ip: req.ip,
    });
    if (format === 'xlsx') {
      reply
        .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('content-disposition', `attachment; filename="${base}.xlsx"`);
      return reply.send(await toXlsx(rows, COLUMNS, 'Attendance'));
    }
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${base}.csv"`);
    return reply.send(toCsv(rows, COLUMNS));
  });
}
