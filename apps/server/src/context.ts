import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient, Attendee, Device, AdminUser, Event } from '@prisma/client';
import type { Env } from './env';
import type { IdentityProvider } from './services/google';
import type { Hub } from './services/hub';
import type { ManifestResolver } from './services/manifest/resolver';

export interface AppContext {
  env: Env;
  prisma: PrismaClient;
  /** Google sign-in (or the development stand-in). */
  identity: IdentityProvider;
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>;
  hub: Hub;
  resolver: ManifestResolver;
  /** Injectable clock (ms). */
  now: () => number;
  event: () => Promise<Event>;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyRequest {
    attendee?: Attendee;
    device?: Device;
    sessionId?: string;
    admin?: AdminUser;
  }
}
