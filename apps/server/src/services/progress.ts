import type { Attendee, Device } from '@prisma/client';
import type { ProgressBody } from '@eventkit/shared';
import type { AppContext } from '../context';
import { publishCounters } from './counters';

export async function recordProgress(
  ctx: AppContext,
  attendee: Attendee,
  device: Device,
  body: ProgressBody,
) {
  await ctx.prisma.$transaction([
    ...body.items.map((it) =>
      ctx.prisma.setupProgress.upsert({
        where: { deviceId_componentId: { deviceId: device.id, componentId: it.id } },
        create: {
          attendeeId: attendee.id,
          deviceId: device.id,
          componentId: it.id,
          status: it.status,
          step: it.step,
          version: it.version,
          percent: it.percent,
          message: it.message,
        },
        update: {
          status: it.status,
          step: it.step ?? null,
          version: it.version ?? null,
          percent: it.percent ?? null,
          message: it.message ?? null,
        },
      }),
    ),
    ctx.prisma.device.update({
      where: { id: device.id },
      data: { overallPercent: body.overallPercent },
    }),
  ]);
  const installing = body.items.some((i) => i.status === 'running' || i.status === 'failed');
  if (installing && (attendee.status === 'logged_in' || attendee.status === 'invited')) {
    await ctx.prisma.attendee.update({
      where: { id: attendee.id },
      data: { status: 'installing' },
    });
    void publishCounters(ctx);
  }
  ctx.hub.publish({
    type: 'progress',
    data: { attendeeId: attendee.id, overallPercent: body.overallPercent },
  });
}
