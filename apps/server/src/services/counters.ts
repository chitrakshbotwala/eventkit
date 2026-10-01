import type { OverviewCounters } from '@eventkit/shared';
import type { AppContext } from '../context';
import { computeCompliance } from './compliance';
import { getSchedule } from './schedule';

export async function getCounters(ctx: AppContext): Promise<OverviewCounters> {
  const event = await ctx.event();
  const [byStatus, checkedIn, schedule] = await Promise.all([
    ctx.prisma.attendee.groupBy({ by: ['status'], where: { eventId: event.id }, _count: true }),
    ctx.prisma.attendance.count({ where: { eventId: event.id } }),
    getSchedule(ctx),
  ]);
  const count = (s: string) => byStatus.find((b) => b.status === s)?._count ?? 0;
  const rsvp = byStatus.reduce((n, b) => n + b._count, 0);

  let compliant = 0;
  let violations = 0;
  let warnings = 0;
  let unverified = 0;
  if (schedule.startAt && schedule.startAt.getTime() <= ctx.now()) {
    const rows = await computeCompliance(ctx);
    for (const r of rows.filter((r) => r.deviceId)) {
      if (r.status === 'compliant') compliant++;
      else if (r.status === 'violation' || r.status === 'tampered') violations++;
      else if (r.status === 'warning' || r.status === 'monitoring_gap') warnings++;
      else unverified++;
    }
  }

  return {
    rsvp,
    loggedIn: rsvp - count('invited'),
    installing: count('installing') + count('not_ready'),
    ready: count('ready'),
    checkedIn,
    compliant,
    violations,
    warnings,
    unverified,
  };
}

let pending: NodeJS.Timeout | null = null;

/** Debounced counters broadcast to the admin SSE stream. */
export function publishCounters(ctx: AppContext) {
  if (pending || ctx.hub.size === 0) return;
  pending = setTimeout(() => {
    pending = null;
    getCounters(ctx)
      .then((data) => ctx.hub.publish({ type: 'counters', data }))
      .catch(() => undefined);
  }, 1_000);
  pending.unref?.();
}
