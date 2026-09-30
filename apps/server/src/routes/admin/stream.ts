import type { FastifyInstance } from 'fastify';
import type { AdminStreamEvent } from '@eventkit/shared';
import { requireAdmin } from '../../plugins/auth';
import { getCounters } from '../../services/counters';

export async function adminStreamRoutes(app: FastifyInstance) {
  const { ctx } = app;

  app.get('/admin/overview', { preHandler: requireAdmin() }, async () => ({
    counters: await getCounters(ctx),
    serverTime: ctx.now(),
  }));

  /** Server-sent events for the live dashboard. */
  app.get('/admin/stream', { preHandler: requireAdmin() }, async (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (e: AdminStreamEvent) =>
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    res.write('retry: 3000\n\n');
    send({ type: 'counters', data: await getCounters(ctx) });

    const unsubscribe = ctx.hub.subscribe(send);
    const ping = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 20_000);
    const close = () => {
      clearInterval(ping);
      unsubscribe();
    };
    req.raw.on('close', close);
    res.on('error', close);
  });
}
