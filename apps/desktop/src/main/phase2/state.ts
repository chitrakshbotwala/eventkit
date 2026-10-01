import type { PhaseState, Schedule } from '@eventkit/shared';

/** Phase for a schedule at server time `now`. */
export function phaseState(s: Schedule | null, now: number): PhaseState {
  if (!s?.startAt || !s.endAt) return 'none';
  const start = Date.parse(s.startAt);
  const end = Date.parse(s.endAt);
  if (now >= end) return 'ended';
  if (now >= start) return 'active';
  if (now >= start - s.preSyncMinutes * 60_000) return 'presync';
  return 'scheduled';
}

/** Monitoring (and logging) runs during presync and the phase itself. */
export const isMonitoring = (p: PhaseState) => p === 'presync' || p === 'active';

/** Inside the enforced window (after the grace period)? */
export function inEnforcedWindow(s: Schedule | null, now: number): boolean {
  if (!s?.startAt || !s.endAt) return false;
  return now >= Date.parse(s.startAt) + s.graceSeconds * 1000 && now < Date.parse(s.endAt);
}
