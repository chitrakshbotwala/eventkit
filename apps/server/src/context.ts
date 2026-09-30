import type { PrismaClient, Attendee, Device, AdminUser, Event } from '@prisma/client';
import type { Env } from './env';
import type { Mailer } from './services/mailer';
import type { Hub } from './services/hub';
import type { ManifestResolver } from './services/manifest/resolver';

export interface AppContext {
  env: Env;
  prisma: PrismaClient;
  mailer: Mailer;
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
