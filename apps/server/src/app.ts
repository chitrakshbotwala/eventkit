import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { PrismaClient } from '@prisma/client';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { AppContext } from './context';
import type { Env } from './env';
import { HttpError } from './lib/errors';
import { attendeeAuthRoutes } from './routes/auth';
import { apiRoutes } from './routes/api';
import { adminAuthRoutes } from './routes/admin/auth';
import { adminAttendeeRoutes } from './routes/admin/attendees';
import { adminScheduleRoutes } from './routes/admin/schedule';
import { adminSettingsRoutes } from './routes/admin/settings';
import { adminStreamRoutes } from './routes/admin/stream';
import { adminUserRoutes } from './routes/admin/users';
import { currentEvent } from './services/event';
import { Hub } from './services/hub';
import { createMailer, type Mailer } from './services/mailer';
import { mirrorRoot } from './services/mirror';
import { upstreamResolver, type ManifestResolver } from './services/manifest/resolver';

export interface BuildOptions {
  env: Env;
  prisma: PrismaClient;
  mailer?: Mailer;
  resolver?: ManifestResolver;
  now?: () => number;
  logger?: boolean;
}

const API_PREFIXES = ['/api/', '/admin/', '/auth/', '/mirror/'];

export async function buildApp(opts: BuildOptions): Promise<FastifyInstance> {
  const { env, prisma } = opts;
  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : { level: env.LOG_LEVEL, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 2 * 1024 * 1024,
  });

  const ctx: AppContext = {
    env,
    prisma,
    mailer: opts.mailer ?? createMailer(env, app.log),
    hub: new Hub(),
    resolver: opts.resolver ?? upstreamResolver,
    now: opts.now ?? Date.now,
    event: () => currentEvent(prisma, env),
  };
  app.decorate('ctx', ctx);

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 1200,
    timeWindow: '1 minute',
    // Venue NAT: everyone shares one IP, so per-IP limits stay generous.
    keyGenerator: (req) => req.ip,
  });

  app.addContentTypeParser(
    ['application/zip', 'application/octet-stream', 'application/x-zip-compressed'],
    { parseAs: 'buffer', bodyLimit: 200 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(self), microphone=(), geolocation=()');
    if (env.NODE_ENV === 'production') {
      reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    const type = String(reply.getHeader('content-type') ?? '');
    if (type.startsWith('text/html')) {
      reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    }
    if (req.url.startsWith('/admin/') || req.url.startsWith('/auth/'))
      reply.header('cache-control', 'no-store');
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      if (err.headers) for (const [k, v] of Object.entries(err.headers)) reply.header(k, v);
      return reply
        .status(err.statusCode)
        .send({ error: err.code, message: err.message, details: err.details });
    }
    const status = err.statusCode ?? 500;
    if (status === 429) {
      return reply
        .status(429)
        .send({ error: 'rate_limited', message: 'Too many requests, slow down.' });
    }
    if (status < 500) {
      return reply.status(status).send({ error: err.code ?? 'bad_request', message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', message: 'Internal server error' });
  });

  await app.register(attendeeAuthRoutes);
  await app.register(apiRoutes);
  await app.register(adminAuthRoutes);
  await app.register(adminAttendeeRoutes);
  await app.register(adminScheduleRoutes);
  await app.register(adminSettingsRoutes);
  await app.register(adminUserRoutes);
  await app.register(adminStreamRoutes);

  // LAN mirror: artifacts are hash-verified by clients, so plain HTTP on a LAN is acceptable.
  const mirror = mirrorRoot(env.DATA_DIR);
  await mkdir(mirror, { recursive: true });
  await app.register(fastifyStatic, {
    root: mirror,
    prefix: '/mirror/',
    decorateReply: false,
    index: false,
    list: false,
    dotfiles: 'deny',
  });

  // Admin SPA (built by apps/admin) with history-API fallback.
  const adminDir = resolve(env.ADMIN_STATIC_DIR);
  const hasAdmin = existsSync(resolve(adminDir, 'index.html'));
  if (hasAdmin) {
    await app.register(fastifyStatic, {
      root: adminDir,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],
    });
  }
  app.setNotFoundHandler((req, reply) => {
    const isApi = API_PREFIXES.some((p) => req.url.startsWith(p));
    if (
      hasAdmin &&
      req.method === 'GET' &&
      !isApi &&
      (req.headers.accept ?? '').includes('text/html')
    ) {
      return reply.type('text/html').sendFile('index.html', adminDir);
    }
    return reply.status(404).send({ error: 'not_found', message: 'Not found' });
  });

  return app;
}
