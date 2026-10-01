import { ed25519 } from '@noble/curves/ed25519.js';
import { canonicalJson } from '../canonical-json';
import {
  ManifestPayloadSchema,
  SignedManifestSchema,
  type ManifestPayload,
  type SignedManifest,
} from '../schemas/manifest';
import { sha256Hex } from './crypto-utils';

export interface SigningKeyPair {
  /** base64 32-byte Ed25519 secret key (seed). Keep private. */
  privateKey: string;
  /** base64 32-byte Ed25519 public key. Embedded in the desktop app. */
  publicKey: string;
  keyId: string;
}

export function keyIdFor(publicKeyB64: string): string {
  return sha256Hex(Buffer.from(publicKeyB64, 'base64')).slice(0, 16);
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { secretKey, publicKey } = ed25519.keygen();
  const pub = Buffer.from(publicKey).toString('base64');
  return {
    privateKey: Buffer.from(secretKey).toString('base64'),
    publicKey: pub,
    keyId: keyIdFor(pub),
  };
}

export function publicKeyFromPrivate(privateKeyB64: string): string {
  return Buffer.from(ed25519.getPublicKey(Buffer.from(privateKeyB64, 'base64'))).toString('base64');
}

export function signManifest(payload: ManifestPayload, privateKeyB64: string): SignedManifest {
  const secret = Buffer.from(privateKeyB64, 'base64');
  if (secret.length !== 32) throw new Error('manifest signing key must be 32 bytes (base64)');
  const pub = Buffer.from(ed25519.getPublicKey(secret)).toString('base64');
  const message = new TextEncoder().encode(canonicalJson(payload));
  const signature = Buffer.from(ed25519.sign(message, secret)).toString('base64');
  return { alg: 'Ed25519', keyId: keyIdFor(pub), signature, payload };
}

export class ManifestVerificationError extends Error {
  override name = 'ManifestVerificationError';
}

/**
 * Verify a signed manifest envelope against trusted public keys (base64).
 * The signature is checked over the RAW payload before schema parsing, so
 * defaults added by parsing cannot change what was signed.
 */
export function verifySignedManifest(
  envelope: unknown,
  trustedPublicKeys: readonly string[],
  opts: { now?: number; expect?: { os: string; arch: string } } = {},
): ManifestPayload {
  const env = SignedManifestSchema.safeParse(envelope);
  if (!env.success) throw new ManifestVerificationError('manifest envelope malformed');
  const { keyId, signature, payload } = env.data;
  const key = trustedPublicKeys.find((k) => keyIdFor(k) === keyId);
  if (!key) throw new ManifestVerificationError(`manifest signed by unknown key ${keyId}`);

  let message: Uint8Array;
  try {
    message = new TextEncoder().encode(canonicalJson(payload));
  } catch {
    throw new ManifestVerificationError('manifest payload not canonicalizable');
  }
  const sig = Buffer.from(signature, 'base64');
  let ok = false;
  try {
    ok =
      sig.length === 64 &&
      ed25519.verify(sig, message, Buffer.from(key, 'base64'), { zip215: false });
  } catch {
    ok = false;
  }
  if (!ok) throw new ManifestVerificationError('manifest signature invalid');

  const parsed = ManifestPayloadSchema.safeParse(payload);
  if (!parsed.success) throw new ManifestVerificationError('manifest payload schema invalid');
  const m = parsed.data;
  const now = opts.now ?? Date.now();
  if (Date.parse(m.expiresAt) < now) throw new ManifestVerificationError('manifest expired');
  if (opts.expect && (m.target.os !== opts.expect.os || m.target.arch !== opts.expect.arch)) {
    throw new ManifestVerificationError('manifest is for a different platform');
  }
  return m;
}
