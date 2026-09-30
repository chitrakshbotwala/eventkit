import type { ComplianceStatus, LogEventType, NetState, PhaseMode } from '../schemas/phase2';

export interface PolicyEntry {
  logId: string;
  seq: number;
  /** Client wall time (ms) already corrected by the entry's server offset. */
  time: number;
  monoMs: number;
  bootId: string;
  type: LogEventType;
  state?: NetState;
  source: 'realtime' | 'uploaded_log';
}

export interface PolicyWindow {
  startAt: number;
  endAt: number;
  graceSeconds: number;
  mode: PhaseMode;
  heartbeatSeconds: number;
}

export interface ComplianceInput {
  window: PolicyWindow;
  entries: PolicyEntry[];
  /** At least one uploaded log with a valid chain. */
  logVerified: boolean;
  /** Any chain/hmac/sequence failure in uploaded logs or realtime entries. */
  tampered: boolean;
  now: number;
}

export interface Interval {
  from: number;
  to: number;
}

export interface ComplianceResult {
  status: ComplianceStatus;
  flags: ComplianceStatus[];
  firstSeenOnline: number | null;
  totalOnlineSeconds: number;
  onlineCount: number;
  limitedSeconds: number;
  gapSeconds: number;
  gaps: Interval[];
  onlineIntervals: Interval[];
  lastEventAt: number | null;
  notes: string[];
}

const PRIORITY: ComplianceStatus[] = [
  'tampered',
  'violation',
  'monitoring_gap',
  'unverified',
  'warning',
  'compliant',
];

/** Max silence between entries (while the app runs) before it counts as a gap. */
export function gapThresholdMs(heartbeatSeconds: number): number {
  return heartbeatSeconds * 2000 + 30_000;
}

function clip(iv: Interval, lo: number, hi: number): Interval | null {
  const from = Math.max(iv.from, lo);
  const to = Math.min(iv.to, hi);
  return to > from ? { from, to } : null;
}

function sumSeconds(ivs: Interval[]): number {
  return ivs.reduce((s, iv) => s + (iv.to - iv.from), 0) / 1000;
}

/** Entries that carry a network state reading. */
function stateOf(e: PolicyEntry): NetState | 'unmonitored' | undefined {
  switch (e.type) {
    case 'online':
      return 'online';
    case 'limited':
      return 'limited';
    case 'offline':
      return 'offline';
    case 'heartbeat':
    case 'phase_start':
    case 'phase_end':
    case 'resume':
    case 'app_start':
      return e.state;
    case 'app_stop':
    case 'suspend':
      return 'unmonitored';
    default:
      return undefined;
  }
}

/**
 * Evaluate phase-2 compliance for one attendee from their (deduplicated) log entries.
 *
 * - violation: internet reachable at any time within [start + grace, end]
 * - warning: strict mode and an interface was up without internet, or clock anomalies
 * - monitoring_gap: app not running / silent inside the window (based on uploaded logs)
 * - unverified: no verified uploaded log covering the full window yet
 * - tampered: broken hash chain / HMAC
 */
export function evaluateCompliance(input: ComplianceInput): ComplianceResult {
  const { window: w, now } = input;
  const notes: string[] = [];
  const entries = [...input.entries].sort((a, b) => a.time - b.time || a.seq - b.seq);
  const enforceFrom = w.startAt + w.graceSeconds * 1000;
  const windowEnd = Math.min(w.endAt, now);
  const threshold = gapThresholdMs(w.heartbeatSeconds);

  // Build state intervals. A state holds from its entry until the next state-bearing entry.
  const online: Interval[] = [];
  const limited: Interval[] = [];
  let cur: { state: NetState | 'unmonitored'; from: number; confirmed: number } | null = null;
  const close = (to: number) => {
    if (!cur) return;
    // A state is not extended across silence longer than the gap threshold, and a
    // single reading still counts for at least one second.
    const end = Math.min(to, cur.confirmed + threshold);
    const iv = { from: cur.from, to: Math.max(end, cur.from + 1000) };
    if (cur.state === 'online') online.push(iv);
    else if (cur.state === 'limited') limited.push(iv);
  };
  let clockAnomalies = 0;
  for (const e of entries) {
    if (e.type === 'clock_anomaly') clockAnomalies++;
    const s = stateOf(e);
    if (s === undefined) continue;
    if (cur && cur.state === s) {
      cur.confirmed = e.time;
      continue;
    }
    close(e.time);
    cur = { state: s, from: e.time, confirmed: e.time };
  }
  const lastEventAt = entries.length ? entries[entries.length - 1]!.time : null;
  if (cur) close(lastEventAt ?? cur.from);

  const onlineIn = online.map((iv) => clip(iv, enforceFrom, w.endAt)).filter(Boolean) as Interval[];
  const limitedIn = limited
    .map((iv) => clip(iv, enforceFrom, w.endAt))
    .filter(Boolean) as Interval[];

  // Gaps: computed from uploaded-log coverage only (realtime entries cannot prove absence).
  // Each running-app entry proves monitoring for `threshold` ms after it; app_stop and
  // suspend prove nothing afterwards. Anything in [start, lastUploaded] not covered is a gap.
  const uploaded = entries.filter((e) => e.source === 'uploaded_log');
  let mergedGaps: Interval[] = [];
  if (uploaded.length > 0 && now > w.startAt) {
    const evalEnd = Math.min(windowEnd, uploaded[uploaded.length - 1]!.time);
    // Coverage never extends past the next app_stop/suspend.
    const nextStop: number[] = new Array<number>(uploaded.length);
    let stopAt = Infinity;
    for (let i = uploaded.length - 1; i >= 0; i--) {
      nextStop[i] = stopAt;
      if (stateOf(uploaded[i]!) === 'unmonitored') stopAt = uploaded[i]!.time;
    }
    const covered = mergeIntervals(
      uploaded.flatMap((e, i) =>
        stateOf(e) === 'unmonitored'
          ? []
          : [{ from: e.time, to: Math.min(e.time + threshold, nextStop[i]!) }],
      ),
    );
    mergedGaps = subtractIntervals({ from: w.startAt, to: evalEnd }, covered);
    if (uploaded[0]!.time > w.startAt) notes.push('monitor was not running at phase start');
  }

  const coversWindow = uploaded.some((e) => e.time >= w.endAt - threshold);
  const phaseOver = now >= w.endAt;

  const flags = new Set<ComplianceStatus>();
  if (input.tampered) flags.add('tampered');
  if (onlineIn.length > 0) flags.add('violation');
  if (mergedGaps.length > 0) flags.add('monitoring_gap');
  if (!input.logVerified || !phaseOver || !coversWindow) flags.add('unverified');
  if (w.mode === 'strict' && limitedIn.length > 0) flags.add('warning');
  if (clockAnomalies > 0) {
    flags.add('warning');
    notes.push(`${clockAnomalies} clock anomal${clockAnomalies === 1 ? 'y' : 'ies'} recorded`);
  }
  if (!phaseOver) notes.push('phase still running');
  else if (!coversWindow) notes.push('log does not cover the end of the window yet');
  if (entries.length === 0) notes.push('no data received');

  const status = PRIORITY.find((p) => flags.has(p)) ?? 'compliant';
  const ordered = PRIORITY.filter((p) => flags.has(p));

  return {
    status,
    flags: ordered.length ? ordered : ['compliant'],
    firstSeenOnline: onlineIn[0]?.from ?? null,
    totalOnlineSeconds: sumSeconds(onlineIn),
    onlineCount: onlineIn.length,
    limitedSeconds: sumSeconds(limitedIn),
    gapSeconds: sumSeconds(mergedGaps),
    gaps: mergedGaps,
    onlineIntervals: onlineIn,
    lastEventAt,
    notes,
  };
}

export function mergeIntervals(ivs: Interval[]): Interval[] {
  const sorted = [...ivs].sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.from <= last.to) last.to = Math.max(last.to, iv.to);
    else out.push({ ...iv });
  }
  return out;
}

/** Parts of `range` not covered by the (merged, sorted) `covered` intervals. */
export function subtractIntervals(range: Interval, covered: Interval[]): Interval[] {
  const out: Interval[] = [];
  let cursor = range.from;
  for (const c of covered) {
    if (c.to <= cursor) continue;
    if (c.from >= range.to) break;
    if (c.from > cursor) out.push({ from: cursor, to: Math.min(c.from, range.to) });
    cursor = Math.max(cursor, c.to);
    if (cursor >= range.to) break;
  }
  if (cursor < range.to) out.push({ from: cursor, to: range.to });
  return out;
}

/** Client-side classification used by the live indicator and the monitor. */
export function classifyNetState(interfaceUp: boolean, internetReachable: boolean): NetState {
  if (internetReachable) return 'online';
  return interfaceUp ? 'limited' : 'offline';
}

/** Whether a live net state is a violation / warning under the phase policy. */
export function liveSeverity(state: NetState, mode: PhaseMode): 'violation' | 'warning' | 'ok' {
  if (state === 'online') return 'violation';
  if (state === 'limited' && mode === 'strict') return 'warning';
  return 'ok';
}
