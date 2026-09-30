import type { FastifyInstance } from 'fastify';
import { ScheduleUpdateBodySchema } from '@eventkit/shared';
import { parse } from '../../lib/errors';
import { requireAdmin } from '../../plugins/auth';
import { audit } from '../../services/audit';
import { invalidateCompliance } from '../../services/compliance';
import {
  endNow,
  getSchedule,
  scheduleDto,
  startNow,
  updateSchedule,
} from '../../services/schedule';

export async function adminScheduleRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const superadmin = requireAdmin('superadmin');

  const done = async (
    req: { admin?: { id: string; email: string }; ip: string },
    action: string,
    s: Awaited<ReturnType<typeof getSchedule>>,
  ) => {
    await audit(ctx.prisma, {
      actorType: 'admin',
      actorId: req.admin!.id,
      actorLabel: req.admin!.email,
      action,
      data: scheduleDto(s),
      ip: req.ip,
    });
    invalidateCompliance();
    ctx.hub.publish({ type: 'schedule', data: { version: s.version } });
    return { schedule: scheduleDto(s), serverTime: ctx.now() };
  };

  app.get('/admin/schedule', { preHandler: requireAdmin() }, async () => ({
    schedule: scheduleDto(await getSchedule(ctx)),
    serverTime: ctx.now(),
  }));

  app.put('/admin/schedule', { preHandler: superadmin }, async (req) => {
    const body = parse(ScheduleUpdateBodySchema, req.body);
    return done(req, 'schedule.update', await updateSchedule(ctx, body));
  });

  app.post('/admin/schedule/start-now', { preHandler: superadmin }, async (req) =>
    done(req, 'schedule.start_now', await startNow(ctx)),
  );

  app.post('/admin/schedule/end-now', { preHandler: superadmin }, async (req) =>
    done(req, 'schedule.end_now', await endNow(ctx)),
  );
}
