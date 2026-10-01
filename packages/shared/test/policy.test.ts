import { describe, expect, it } from 'vitest';
import {
  classifyNetState,
  evaluateCompliance,
  liveSeverity,
  subtractIntervals,
  type LogEventType,
  type NetState,
  type PolicyEntry,
  type PolicyWindow,
} from '../src';

const MIN = 60_000;
const START = Date.UTC(2026, 9, 10, 10, 0, 0);
const END = START + 60 * MIN;
const win = (over: Partial<PolicyWindow> = {}): PolicyWindow => ({
  startAt: START,
  endAt: END,
  graceSeconds: 120,
  mode: 'strict',
  heartbeatSeconds: 60,
  ...over,
});

let seq = 0;
function e(
  minute: number,
  type: LogEventType,
  state?: NetState,
  source: PolicyEntry['source'] = 'uploaded_log',
): PolicyEntry {
  return {
    logId: 'l',
    seq: seq++,
    time: START + minute * MIN,
    monoMs: 0,
    bootId: 'b',
    type,
    state,
    source,
  };
}

/** Heartbeats every minute from `from` to `to` minutes, offline. */
function heartbeats(from: number, to: number, state: NetState = 'offline'): PolicyEntry[] {
  const out: PolicyEntry[] = [];
  for (let m = from; m <= to; m++) out.push(e(m, 'heartbeat', state));
  return out;
}

const after = END + 5 * MIN;

describe('evaluateCompliance', () => {
  it('compliant: full offline coverage with verified log', () => {
    const entries = [
      e(-10, 'app_start', 'online'),
      e(-3, 'offline'),
      ...heartbeats(-2, 60),
      e(60, 'phase_end', 'offline'),
    ];
    const r = evaluateCompliance({
      window: win(),
      entries,
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(r.status).toBe('compliant');
    expect(r.flags).toEqual(['compliant']);
    expect(r.totalOnlineSeconds).toBe(0);
    expect(r.gapSeconds).toBe(0);
  });

  it('being online during the grace period is not a violation', () => {
    const entries = [
      e(-10, 'app_start', 'online'),
      ...heartbeats(-9, 0, 'online'),
      e(1, 'offline'),
      ...heartbeats(2, 60),
    ];
    const r = evaluateCompliance({
      window: win(),
      entries,
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(r.status).toBe('compliant');
  });

  it('violation: online for a few seconds mid-window (from uploaded log)', () => {
    const entries = [...heartbeats(-2, 60)];
    const blip = e(30, 'online');
    blip.time += 10_000;
    const back = e(30, 'offline');
    back.time += 15_000;
    entries.push(blip, back);
    const r = evaluateCompliance({
      window: win(),
      entries,
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(r.status).toBe('violation');
    expect(r.onlineCount).toBe(1);
    expect(r.totalOnlineSeconds).toBe(5);
    expect(r.firstSeenOnline).toBe(START + 30 * MIN + 10_000);
  });

  it('violation from realtime events is final even before the log upload', () => {
    const entries = [e(20, 'online', undefined, 'realtime')];
    const r = evaluateCompliance({
      window: win(),
      entries,
      logVerified: false,
      tampered: false,
      now: START + 21 * MIN,
    });
    expect(r.status).toBe('violation');
    expect(r.flags).toContain('unverified');
    expect(r.totalOnlineSeconds).toBeGreaterThanOrEqual(1);
  });

  it('online state is not stretched across long silences', () => {
    const entries = [
      ...heartbeats(-2, 10),
      e(11, 'online'),
      e(50, 'heartbeat', 'offline'),
      ...heartbeats(51, 60),
    ];
    const r = evaluateCompliance({
      window: win(),
      entries,
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(r.status).toBe('violation');
    // capped at the gap threshold (150 s) instead of 39 minutes
    expect(r.totalOnlineSeconds).toBe(150);
  });

  it('warning: interface up without internet in strict mode only', () => {
    const entries = [
      ...heartbeats(-2, 29),
      e(30, 'limited'),
      e(31, 'offline'),
      ...heartbeats(32, 60),
    ];
    const strict = evaluateCompliance({
      window: win(),
      entries,
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(strict.status).toBe('warning');
    expect(strict.limitedSeconds).toBe(60);
    const lenient = evaluateCompliance({
      window: win({ mode: 'lenient' }),
      entries,
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(lenient.status).toBe('compliant');
  });

  it('monitoring gap: app stopped mid-window', () => {
    const entries = [
      ...heartbeats(-2, 20),
      e(20.5, 'app_stop'),
      e(40, 'app_start', 'offline'),
      ...heartbeats(41, 60),
    ];
    const r = evaluateCompliance({
      window: win(),
      entries,
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(r.status).toBe('monitoring_gap');
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]!.from).toBe(START + 20.5 * 60_000);
    expect(r.gaps[0]!.to).toBe(START + 40 * MIN);
  });

  it('monitoring gap: app not running at phase start', () => {
    const entries = [e(15, 'app_start', 'offline'), ...heartbeats(16, 60)];
    const r = evaluateCompliance({
      window: win(),
      entries,
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(r.status).toBe('monitoring_gap');
    expect(r.notes.join()).toMatch(/not running at phase start/);
  });

  it('silence longer than the threshold is a gap; short silence is not', () => {
    const entries = [...heartbeats(-2, 10), ...heartbeats(12, 30), ...heartbeats(40, 60)];
    const r = evaluateCompliance({
      window: win(),
      entries,
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(r.status).toBe('monitoring_gap');
    expect(r.gaps).toHaveLength(1);
    expect(r.gapSeconds).toBe(10 * 60 - 150);
  });

  it('ignores sub-minute gaps (monitor started a few seconds late)', () => {
    const entries = [e(0.5, 'app_start', 'offline'), ...heartbeats(1, 60)];
    const r = evaluateCompliance({
      window: win(),
      entries,
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(r.gaps).toEqual([]);
    expect(r.status).toBe('compliant');
    expect(r.notes.join()).not.toMatch(/not running at phase start/);
  });

  it('unverified: no uploaded log, or log not covering the end', () => {
    const none = evaluateCompliance({
      window: win(),
      entries: [],
      logVerified: false,
      tampered: false,
      now: after,
    });
    expect(none.status).toBe('unverified');
    const partial = evaluateCompliance({
      window: win(),
      entries: heartbeats(-2, 30),
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(partial.status).toBe('unverified');
  });

  it('unverified while the phase is still running', () => {
    const r = evaluateCompliance({
      window: win(),
      entries: heartbeats(-2, 30),
      logVerified: true,
      tampered: false,
      now: START + 30 * MIN,
    });
    expect(r.status).toBe('unverified');
    expect(r.notes).toContain('phase still running');
  });

  it('tampered outranks everything', () => {
    const entries = [...heartbeats(-2, 60), e(30, 'online')];
    const r = evaluateCompliance({
      window: win(),
      entries,
      logVerified: false,
      tampered: true,
      now: after,
    });
    expect(r.status).toBe('tampered');
    expect(r.flags.slice(0, 2)).toEqual(['tampered', 'violation']);
  });

  it('clock anomalies raise a warning', () => {
    const entries = [...heartbeats(-2, 60), e(30, 'clock_anomaly')];
    const r = evaluateCompliance({
      window: win(),
      entries,
      logVerified: true,
      tampered: false,
      now: after,
    });
    expect(r.status).toBe('warning');
  });
});

describe('helpers', () => {
  it('classifies net state and live severity', () => {
    expect(classifyNetState(true, true)).toBe('online');
    expect(classifyNetState(false, true)).toBe('online');
    expect(classifyNetState(true, false)).toBe('limited');
    expect(classifyNetState(false, false)).toBe('offline');
    expect(liveSeverity('online', 'lenient')).toBe('violation');
    expect(liveSeverity('limited', 'strict')).toBe('warning');
    expect(liveSeverity('limited', 'lenient')).toBe('ok');
  });

  it('subtracts intervals', () => {
    expect(
      subtractIntervals({ from: 0, to: 100 }, [
        { from: -5, to: 10 },
        { from: 20, to: 30 },
        { from: 90, to: 200 },
      ]),
    ).toEqual([
      { from: 10, to: 20 },
      { from: 30, to: 90 },
    ]);
    expect(subtractIntervals({ from: 0, to: 10 }, [])).toEqual([{ from: 0, to: 10 }]);
  });
});
