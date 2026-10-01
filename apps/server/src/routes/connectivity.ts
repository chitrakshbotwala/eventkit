import type { FastifyInstance } from 'fastify';
import { ConnectivityEventsBodySchema, ConnectivityLogBodySchema } from '@eventkit/shared';
import { parse } from '../lib/errors';
import { requireAttendee } from '../plugins/auth';
import { ingestLog, ingestRealtime } from '../services/connectivity';

export async function connectivityRoutes(app: FastifyInstance) {
  const { ctx } = app;

  app.post(
    '/api/connectivity/events',
    { preHandler: requireAttendee, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req) => {
      const { entries } = parse(ConnectivityEventsBodySchema, req.body);
      return ingestRealtime(ctx, req.attendee!, req.device!, entries);
    },
  );

  app.post(
    '/api/connectivity/log',
    {
      preHandler: requireAttendee,
      bodyLimit: 30 * 1024 * 1024,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const body = parse(ConnectivityLogBodySchema, req.body);
      return ingestLog(ctx, req.attendee!, req.device!, body, req.ip);
    },
  );
}
