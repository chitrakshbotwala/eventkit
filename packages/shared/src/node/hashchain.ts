import { canonicalJson } from '../canonical-json';
import { GENESIS_HASH } from '../constants';
import type { LogEntry, LogEntryBody } from '../schemas/phase2';
import { hmacSha256Hex, safeEqual, sha256Hex } from './crypto-utils';

export function entryHash(body: LogEntryBody): string {
  const { logId, seq, wallTime, monoMs, bootId, offsetMs, type, data, prevHash } = body;
  return sha256Hex(
    canonicalJson({ logId, seq, wallTime, monoMs, bootId, offsetMs, type, data, prevHash }),
  );
}

export function sealEntry(body: LogEntryBody, deviceKey: Uint8Array): LogEntry {
  const hash = entryHash(body);
  return { ...body, hash, hmac: hmacSha256Hex(deviceKey, hash) };
}

/** Returns an error string, or null when the entry's hash and HMAC are valid. */
export function verifyEntry(entry: LogEntry, deviceKey: Uint8Array): string | null {
  const hash = entryHash(entry);
  if (!safeEqual(hash, entry.hash)) return `seq ${entry.seq}: hash mismatch`;
  if (!safeEqual(hmacSha256Hex(deviceKey, hash), entry.hmac))
    return `seq ${entry.seq}: hmac invalid`;
  return null;
}

export interface ChainVerification {
  valid: boolean;
  errors: string[];
  lastSeq: number | null;
  clockAnomalies: Array<{ seq: number; reason: string }>;
}

/** Tolerated drift between wall and monotonic deltas within one boot. */
export const CLOCK_TOLERANCE_MS = 10_000;

/**
 * Verify a full log: contiguous seq starting at 0, prevHash links, per-entry
 * hash + HMAC, a single logId, and a monotonic clock that never decreases
 * within a boot. Wall/monotonic divergence is reported as a clock anomaly
 * (not tampering), except right after a suspend, where the monotonic clock
 * may legitimately pause.
 */
export function verifyChain(entries: LogEntry[], deviceKey: Uint8Array): ChainVerification {
  const errors: string[] = [];
  const clockAnomalies: ChainVerification['clockAnomalies'] = [];
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  let prev: LogEntry | null = null;

  for (const e of sorted) {
    const err = verifyEntry(e, deviceKey);
    if (err) errors.push(err);
    if (!prev) {
      if (e.seq !== 0) errors.push(`log starts at seq ${e.seq}, expected 0`);
      if (e.prevHash !== GENESIS_HASH) errors.push('first entry does not link to genesis');
    } else {
      if (e.logId !== prev.logId) errors.push(`seq ${e.seq}: logId changed`);
      if (e.seq === prev.seq) errors.push(`seq ${e.seq}: duplicate`);
      else if (e.seq !== prev.seq + 1) {
        errors.push(`missing entries between seq ${prev.seq} and ${e.seq}`);
      }
      if (e.prevHash !== prev.hash)
        errors.push(`seq ${e.seq}: prevHash does not match seq ${prev.seq}`);
      if (e.bootId === prev.bootId) {
        const monoDelta = e.monoMs - prev.monoMs;
        const wallDelta = e.wallTime - prev.wallTime;
        if (monoDelta < 0) errors.push(`seq ${e.seq}: monotonic clock went backwards`);
        else if (prev.type !== 'suspend' && Math.abs(wallDelta - monoDelta) > CLOCK_TOLERANCE_MS) {
          clockAnomalies.push({
            seq: e.seq,
            reason: `wall clock moved ${wallDelta} ms while monotonic moved ${Math.round(monoDelta)} ms`,
          });
        }
      }
      if (e.wallTime < prev.wallTime - CLOCK_TOLERANCE_MS) {
        clockAnomalies.push({ seq: e.seq, reason: 'wall clock went backwards' });
      }
    }
    prev = e;
  }
  return { valid: errors.length === 0, errors, lastSeq: prev ? prev.seq : null, clockAnomalies };
}
