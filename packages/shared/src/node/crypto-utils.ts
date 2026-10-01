import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(key: Uint8Array, data: string | Uint8Array): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function randomTokenB64Url(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomKeyB64(bytes = 32): string {
  return randomBytes(bytes).toString('base64');
}

export function b64ToBytes(b64: string): Buffer {
  return Buffer.from(b64, /[-_]/.test(b64) ? 'base64url' : 'base64');
}

/** Constant-time comparison of two equal-format strings (hex, digits, ...). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Compare against itself to keep timing flat, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}
