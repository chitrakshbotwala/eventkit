import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  ManifestQuerySchema,
  ProgressBodySchema,
  type MeResponse,
  type ScheduleResponse,
  type TimeResponse,
} from '@eventkit/shared';
import { notFound, parse } from '../lib/errors';
import { requireAttendee } from '../plugins/auth';
import { toProfile } from '../services/attendees';
import { signedManifestFor } from '../services/manifest/service';
import { getSchedule, scheduleDto } from '../services/schedule';
import { recordProgress } from '../services/progress';

export async function apiRoutes(app: FastifyInstance) {
  const { ctx } = app;

  app.get('/api/time', async (): Promise<TimeResponse> => ({ now: ctx.now() }));

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/manifest', async (req, reply) => {
    const { os, arch } = parse(ManifestQuerySchema, req.query);
    const signed = await signedManifestFor(ctx, os, arch);
    reply.header('cache-control', 'no-store');
    return signed;
  });

  app.get('/api/schedule', async (_req, reply): Promise<ScheduleResponse> => {
    reply.header('cache-control', 'no-store');
    return { schedule: scheduleDto(await getSchedule(ctx)), serverTime: ctx.now() };
  });

  app.get('/api/me', { preHandler: requireAttendee }, async (req): Promise<MeResponse> => {
    const a = await ctx.prisma.attendee.findUniqueOrThrow({
      where: { id: req.attendee!.id },
      include: { attendance: true },
    });
    return { attendee: toProfile(a), serverTime: ctx.now() };
  });

  app.post(
    '/api/progress',
    { preHandler: requireAttendee, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const body = parse(ProgressBodySchema, req.body);
      await recordProgress(ctx, req.attendee!, req.device!, body);
      return { ok: true };
    },
  );

  // Starter project zip (content-addressed; integrity is checked by the client against the manifest).
  app.get<{ Params: { file: string } }>('/api/starter-project/:file', async (req, reply) => {
    const m = /^([a-f0-9]{64})\.zip$/.exec(req.params.file);
    if (!m) throw notFound();
    const path = join(resolve(ctx.env.DATA_DIR, 'starter'), `${m[1]}.zip`);
    const st = await stat(path).catch(() => null);
    if (!st) throw notFound();
    reply.header('content-type', 'application/zip');
    reply.header('content-length', String(st.size));
    reply.header('cache-control', 'public, max-age=31536000, immutable');
    return reply.send(createReadStream(path));
  });
}
