import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, type LogEntry, type LogEventType, type NetState } from '../src';
import { sealEntry, verifyChain, verifyEntry } from '../src/node';

const key = Buffer.alloc(32, 1);
const LOG_ID = '6f1c1c9e-3c1a-4f7e-9d8c-2b0b8a1e5f10';

function buildLog(
  steps: Array<{
    type: LogEventType;
    dt?: number;
    dmono?: number;
    state?: NetState;
    boot?: string;
  }>,
  k: Uint8Array = key,
): LogEntry[] {
  const out: LogEntry[] = [];
  let wall = 1_800_000_000_000;
  let mono = 1_000;
  let prevHash = GENESIS_HASH;
  steps.forEach((s, seq) => {
    wall += s.dt ?? 5_000;
    mono += s.dmono ?? s.dt ?? 5_000;
    const e = sealEntry(
      {
        logId: LOG_ID,
        seq,
        wallTime: wall,
        monoMs: mono,
        bootId: s.boot ?? 'boot-a',
        offsetMs: 0,
        type: s.type,
        data: s.state ? { state: s.state } : {},
        prevHash,
      },
      k,
    );
    prevHash = e.hash;
    out.push(e);
  });
  return out;
}

const normal = () =>
  buildLog([
    { type: 'app_start', state: 'offline' },
    { type: 'heartbeat', state: 'offline', dt: 60_000 },
    { type: 'online' },
    { type: 'offline' },
    { type: 'heartbeat', state: 'offline', dt: 60_000 },
  ]);

describe('hash chain', () => {
  it('verifies an untouched log', () => {
    const r = verifyChain(normal(), key);
    expect(r).toMatchObject({ valid: true, errors: [], lastSeq: 4 });
    expect(r.clockAnomalies).toHaveLength(0);
  });

  it('accepts entries in any order (sorted by seq)', () => {
    expect(verifyChain(normal().reverse(), key).valid).toBe(true);
  });

  it('detects a modified entry (hash mismatch)', () => {
    const log = normal();
    log[2] = { ...log[2]!, type: 'offline' };
    const r = verifyChain(log, key);
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/seq 2: hash mismatch/);
  });

  it('detects a re-hashed entry without the device key (hmac invalid)', () => {
    const log = normal();
    const forged = sealEntry({ ...log[2]!, type: 'offline' }, Buffer.alloc(32, 9));
    log[2] = forged;
    const r = verifyChain(log, key);
    expect(r.errors.join()).toMatch(/seq 2: hmac invalid/);
    expect(r.errors.join()).toMatch(/seq 3: prevHash/);
  });

  it('detects a deleted entry (the "online" event removed)', () => {
    const log = normal();
    log.splice(2, 1);
    const r = verifyChain(log, key);
    expect(r.valid).toBe(false);
    expect(r.errors.join()).toMatch(/missing entries between seq 1 and 3/);
  });

  it('detects a truncated head', () => {
    const r = verifyChain(normal().slice(1), key);
    expect(r.errors.join()).toMatch(/starts at seq 1/);
  });

  it('flags a monotonic clock going backwards as tampering', () => {
    const log = buildLog([{ type: 'app_start' }, { type: 'heartbeat', dmono: -2_000 }]);
    expect(verifyChain(log, key).errors.join()).toMatch(/monotonic clock went backwards/);
  });

  it('reports wall-clock jumps as clock anomalies, not tampering', () => {
    const log = buildLog([
      { type: 'app_start' },
      { type: 'heartbeat', dt: 3_600_000, dmono: 60_000 },
    ]);
    const r = verifyChain(log, key);
    expect(r.valid).toBe(true);
    expect(r.clockAnomalies).toHaveLength(1);
  });

  it('does not flag suspend/resume or reboots as clock anomalies', () => {
    const log = buildLog([
      { type: 'app_start' },
      { type: 'suspend' },
      { type: 'resume', dt: 1_800_000, dmono: 10 },
      { type: 'app_start', dt: 60_000, dmono: -500_000, boot: 'boot-b' },
    ]);
    const r = verifyChain(log, key);
    expect(r.valid).toBe(true);
    expect(r.clockAnomalies).toHaveLength(0);
  });

  it('verifies single realtime entries', () => {
    const [e] = normal();
    expect(verifyEntry(e!, key)).toBeNull();
    expect(verifyEntry(e!, Buffer.alloc(32, 2))).toMatch(/hmac invalid/);
  });
});
