import type { Schedule as ScheduleRow } from '@prisma/client';
import type { PhaseMode, Schedule, ScheduleUpdateBody } from '@eventkit/shared';
import type { AppContext } from '../context';
import { badRequest } from '../lib/errors';

export function scheduleDto(s: ScheduleRow): Schedule {
  return {
    id: s.id,
    version: s.version,
    startAt: s.startAt?.toISOString() ?? null,
    endAt: s.endAt?.toISOString() ?? null,
    timezone: s.timezone,
    mode: s.mode as PhaseMode,
    graceSeconds: s.graceSeconds,
    heartbeatSeconds: s.heartbeatSeconds,
    preSyncMinutes: s.preSyncMinutes,
    updatedAt: s.updatedAt.toISOString(),
  };
}

export async function getSchedule(ctx: AppContext): Promise<ScheduleRow> {
  const event = await ctx.event();
  return ctx.prisma.schedule.upsert({
    where: { eventId: event.id },
    create: { eventId: event.id, timezone: event.timezone },
    update: {},
  });
}

export async function updateSchedule(
  ctx: AppContext,
  body: ScheduleUpdateBody,
): Promise<ScheduleRow> {
  const current = await getSchedule(ctx);
  return ctx.prisma.schedule.update({
    where: { id: current.id },
    data: {
      startAt: body.startAt ? new Date(body.startAt) : null,
      endAt: body.endAt ? new Date(body.endAt) : null,
      timezone: body.timezone,
      mode: body.mode,
      graceSeconds: body.graceSeconds,
      ...(body.heartbeatSeconds ? { heartbeatSeconds: body.heartbeatSeconds } : {}),
      version: { increment: 1 },
    },
  });
}

export async function startNow(ctx: AppContext): Promise<ScheduleRow> {
  const current = await getSchedule(ctx);
  const now = ctx.now();
  const endAt =
    current.endAt && current.endAt.getTime() > now ? current.endAt : new Date(now + 3 * 3600_000);
  return ctx.prisma.schedule.update({
    where: { id: current.id },
    data: { startAt: new Date(now), endAt, version: { increment: 1 } },
  });
}

export async function endNow(ctx: AppContext): Promise<ScheduleRow> {
  const current = await getSchedule(ctx);
  const now = ctx.now();
  if (!current.startAt || current.startAt.getTime() > now) {
    throw badRequest('not_started', 'Phase 2 has not started yet');
  }
  return ctx.prisma.schedule.update({
    where: { id: current.id },
    data: { endAt: new Date(now), version: { increment: 1 } },
  });
}
