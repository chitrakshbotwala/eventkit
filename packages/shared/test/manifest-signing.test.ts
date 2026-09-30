import { describe, expect, it } from 'vitest';
import type { ManifestPayload } from '../src';
import {
  generateSigningKeyPair,
  ManifestVerificationError,
  publicKeyFromPrivate,
  signManifest,
  verifySignedManifest,
} from '../src/node';

const SHA = 'a'.repeat(64);

function samplePayload(overrides: Partial<ManifestPayload> = {}): ManifestPayload {
  return {
    schemaVersion: 1,
    manifestId: 'm-1',
    issuedAt: '2026-09-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:00:00.000Z',
    event: { slug: 'devfest', name: 'DevFest' },
    target: { os: 'windows', arch: 'x64' },
    mirrorBaseUrl: null,
    minAppVersion: '0.1.0',
    placeholder: false,
    components: [
      { id: 'system', name: 'System check', enabled: true, required: true, minDiskGb: 15 },
      {
        id: 'flutter',
        name: 'Flutter SDK',
        enabled: true,
        required: true,
        channel: 'stable',
        version: '3.35.4',
        pinned: true,
        artifact: {
          url: 'https://storage.googleapis.com/flutter_infra_release/releases/stable/windows/flutter_windows_3.35.4-stable.zip',
          sha256: SHA,
          fileName: 'flutter_windows_3.35.4-stable.zip',
          kind: 'zip',
          installArgs: [],
        },
      },
    ],
    ...overrides,
  };
}

describe('manifest signing', () => {
  const keys = generateSigningKeyPair();

  it('round-trips a signed manifest through JSON', () => {
    const env = signManifest(samplePayload(), keys.privateKey);
    const wire = JSON.parse(JSON.stringify(env));
    const m = verifySignedManifest(wire, [keys.publicKey], {
      expect: { os: 'windows', arch: 'x64' },
    });
    expect(m.manifestId).toBe('m-1');
    expect(env.keyId).toBe(keys.keyId);
  });

  it('derives the public key from the private key', () => {
    expect(publicKeyFromPrivate(keys.privateKey)).toBe(keys.publicKey);
  });

  it('is independent of key order in the payload', () => {
    const env = signManifest(samplePayload(), keys.privateKey);
    const p = env.payload as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(p).reverse());
    expect(() =>
      verifySignedManifest({ ...env, payload: reordered }, [keys.publicKey]),
    ).not.toThrow();
  });

  it('rejects a tampered payload (changed hash)', () => {
    const env = signManifest(samplePayload(), keys.privateKey);
    const tampered = JSON.parse(JSON.stringify(env));
    tampered.payload.components[1].artifact.sha256 = 'b'.repeat(64);
    expect(() => verifySignedManifest(tampered, [keys.publicKey])).toThrow(/signature invalid/);
  });

  it('rejects a tampered URL', () => {
    const env = signManifest(samplePayload(), keys.privateKey);
    const tampered = JSON.parse(JSON.stringify(env));
    tampered.payload.components[1].artifact.url = 'https://evil.example/flutter.zip';
    expect(() => verifySignedManifest(tampered, [keys.publicKey])).toThrow(
      ManifestVerificationError,
    );
  });

  it('rejects an added field', () => {
    const env = signManifest(samplePayload(), keys.privateKey);
    const tampered = JSON.parse(JSON.stringify(env));
    tampered.payload.mirrorBaseUrl = 'http://attacker.local';
    expect(() => verifySignedManifest(tampered, [keys.publicKey])).toThrow(/signature invalid/);
  });

  it('rejects unsigned / malformed envelopes', () => {
    expect(() => verifySignedManifest(samplePayload(), [keys.publicKey])).toThrow(/malformed/);
    const env = signManifest(samplePayload(), keys.privateKey);
    expect(() => verifySignedManifest({ ...env, signature: '' }, [keys.publicKey])).toThrow();
  });

  it('rejects manifests signed by an untrusted key', () => {
    const other = generateSigningKeyPair();
    const env = signManifest(samplePayload(), other.privateKey);
    expect(() => verifySignedManifest(env, [keys.publicKey])).toThrow(/unknown key/);
  });

  it('rejects a signature copied onto another key id', () => {
    const other = generateSigningKeyPair();
    const env = signManifest(samplePayload(), other.privateKey);
    expect(() => verifySignedManifest({ ...env, keyId: keys.keyId }, [keys.publicKey])).toThrow(
      /signature invalid/,
    );
  });

  it('rejects expired manifests and wrong platforms', () => {
    const expired = signManifest(
      samplePayload({ expiresAt: '2020-01-01T00:00:00.000Z' }),
      keys.privateKey,
    );
    expect(() => verifySignedManifest(expired, [keys.publicKey])).toThrow(/expired/);
    const env = signManifest(samplePayload(), keys.privateKey);
    expect(() =>
      verifySignedManifest(env, [keys.publicKey], { expect: { os: 'linux', arch: 'x64' } }),
    ).toThrow(/different platform/);
  });

  it('supports key rotation with multiple trusted keys', () => {
    const next = generateSigningKeyPair();
    const env = signManifest(samplePayload(), next.privateKey);
    expect(() => verifySignedManifest(env, [keys.publicKey, next.publicKey])).not.toThrow();
  });
});
