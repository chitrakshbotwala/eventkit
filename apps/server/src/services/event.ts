import type { Event, PrismaClient } from '@prisma/client';
import type { Env } from '../env';

let cached: { slug: string; event: Event } | null = null;

/** The single event this deployment serves (created on first use). */
export async function currentEvent(prisma: PrismaClient, env: Env): Promise<Event> {
  if (cached && cached.slug === env.EVENT_SLUG) return cached.event;
  const event = await prisma.event.upsert({
    where: { slug: env.EVENT_SLUG },
    create: { slug: env.EVENT_SLUG, name: env.EVENT_NAME, timezone: env.EVENT_TIMEZONE },
    update: {},
  });
  cached = { slug: env.EVENT_SLUG, event };
  return event;
}

export function resetEventCache() {
  cached = null;
}
