import { describe, expect, it } from 'vitest';
import { QR_WINDOW_MS } from '../src';
import {
  base32Encode,
  buildQrPayload,
  checkQrCode,
  currentWindow,
  hotp,
  msUntilNextWindow,
  parseQrPayload,
  rotatingCode,
  totp,
  verifyTotp,
} from '../src/node';

const secret = Buffer.alloc(32, 7);
const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);

describe('rotating QR code', () => {
  it('is stable within a window and changes across windows', () => {
    const w = currentWindow(T0);
    expect(rotatingCode(secret, 'att1', w)).toBe(rotatingCode(secret, 'att1', w));
    expect(rotatingCode(secret, 'att1', w)).not.toBe(rotatingCode(secret, 'att1', w + 1));
    expect(rotatingCode(secret, 'att1', w)).toMatch(/^\d{8}$/);
  });

  it('binds the attendee id', () => {
    const w = currentWindow(T0);
    expect(rotatingCode(secret, 'att1', w)).not.toBe(rotatingCode(secret, 'att2', w));
  });

  it('round-trips payloads', () => {
    const p = buildQrPayload(secret, 'cmabc123', 29_000_000);
    expect(p).toMatch(/^EK1\.cmabc123\.29000000\.\d{8}$/);
    expect(parseQrPayload(p)).toEqual({
      attendeeId: 'cmabc123',
      window: 29_000_000,
      code: p.slice(-8),
    });
    expect(parseQrPayload(` ${p}\n`)).not.toBeNull();
    expect(parseQrPayload('EK1.x.1.123')).toBeNull();
    expect(parseQrPayload('https://evil')).toBeNull();
  });

  it('accepts the current window +/- 1 and reports older ones as expired', () => {
    const w = currentWindow(T0);
    const mk = (win: number) => parseQrPayload(buildQrPayload(secret, 'a', win))!;
    expect(checkQrCode(secret, mk(w), T0)).toBe('valid');
    expect(checkQrCode(secret, mk(w - 1), T0)).toBe('valid');
    expect(checkQrCode(secret, mk(w + 1), T0)).toBe('valid');
    expect(checkQrCode(secret, mk(w - 2), T0)).toBe('expired');
    expect(checkQrCode(secret, mk(w - 500), T0)).toBe('expired');
  });

  it('rejects forged codes and wrong secrets as invalid', () => {
    const w = currentWindow(T0);
    const qr = parseQrPayload(buildQrPayload(secret, 'a', w))!;
    expect(
      checkQrCode(secret, { ...qr, code: '00000000' === qr.code ? '11111111' : '00000000' }, T0),
    ).toBe('invalid');
    expect(checkQrCode(Buffer.alloc(32, 8), qr, T0)).toBe('invalid');
    // Replaying a code under a different window number is invalid, not expired.
    expect(checkQrCode(secret, { ...qr, window: w - 10 }, T0)).toBe('invalid');
  });

  it('corrects clock drift with the server offset', () => {
    const clientSkew = -5 * 60_000; // client clock 5 minutes behind
    const clientNow = T0 + clientSkew;
    const offset = T0 - clientNow;
    const w = currentWindow(clientNow, offset);
    const qr = parseQrPayload(buildQrPayload(secret, 'a', w))!;
    expect(checkQrCode(secret, qr, T0)).toBe('valid');
    // Without correction the code would be expired.
    const naive = parseQrPayload(buildQrPayload(secret, 'a', currentWindow(clientNow)))!;
    expect(checkQrCode(secret, naive, T0)).toBe('expired');
  });

  it('computes time until next window', () => {
    const start = currentWindow(T0) * QR_WINDOW_MS;
    expect(msUntilNextWindow(start)).toBe(QR_WINDOW_MS);
    expect(msUntilNextWindow(start + 15_000)).toBe(45_000);
  });
});

describe('admin TOTP (RFC 6238)', () => {
  const rfcSecret = base32Encode(Buffer.from('12345678901234567890'));

  it('encodes the RFC secret in base32', () => {
    expect(rfcSecret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('matches RFC 6238 SHA-1 test vectors (6-digit truncation)', () => {
    expect(totp(rfcSecret, 59_000)).toBe('287082');
    expect(totp(rfcSecret, 1111111109_000)).toBe('081804');
    expect(totp(rfcSecret, 1234567890_000)).toBe('005924');
    expect(hotp(rfcSecret, 0)).toBe('755224');
  });

  it('verifies within +/- 1 step', () => {
    const now = 1234567890_000;
    expect(verifyTotp(rfcSecret, totp(rfcSecret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(rfcSecret, totp(rfcSecret, now - 90_000), now)).toBe(false);
  });
});
