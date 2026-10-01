import { createHmac } from 'node:crypto';
import { QR_ACCEPT_SKEW_WINDOWS, QR_PREFIX, QR_WINDOW_MS } from '../constants';
import { safeEqual } from './crypto-utils';

/** Current 60 s window, corrected by the client's server offset. */
export function currentWindow(nowMs: number, serverOffsetMs = 0): number {
  return Math.floor((nowMs + serverOffsetMs) / QR_WINDOW_MS);
}

/** Milliseconds until the current window ends. */
export function msUntilNextWindow(nowMs: number, serverOffsetMs = 0): number {
  const t = nowMs + serverOffsetMs;
  return QR_WINDOW_MS - (((t % QR_WINDOW_MS) + QR_WINDOW_MS) % QR_WINDOW_MS);
}

/** TOTP-style 8-digit code: dynamic truncation of HMAC-SHA256(secret, "EK1|id|window"). */
export function rotatingCode(secret: Uint8Array, attendeeId: string, window: number): string {
  const mac = createHmac('sha256', secret).update(`${QR_PREFIX}|${attendeeId}|${window}`).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return (bin % 100_000_000).toString().padStart(8, '0');
}

export function buildQrPayload(secret: Uint8Array, attendeeId: string, window: number): string {
  return `${QR_PREFIX}.${attendeeId}.${window}.${rotatingCode(secret, attendeeId, window)}`;
}

export interface ParsedQr {
  attendeeId: string;
  window: number;
  code: string;
}

export function parseQrPayload(payload: string): ParsedQr | null {
  const m = /^EK1\.([A-Za-z0-9_-]{1,64})\.(\d{1,12})\.(\d{8})$/.exec(payload.trim());
  if (!m) return null;
  return { attendeeId: m[1]!, window: Number(m[2]), code: m[3]! };
}

export type QrCheck = 'valid' | 'expired' | 'invalid';

/** Verify a parsed QR against the attendee secret at server time `nowMs`. */
export function checkQrCode(secret: Uint8Array, qr: ParsedQr, nowMs: number): QrCheck {
  const expected = rotatingCode(secret, qr.attendeeId, qr.window);
  if (!safeEqual(expected, qr.code)) return 'invalid';
  const current = currentWindow(nowMs);
  return Math.abs(current - qr.window) <= QR_ACCEPT_SKEW_WINDOWS ? 'valid' : 'expired';
}
