import { afterEach, describe, expect, it } from 'vitest';
import { findComponent, type SignedManifest } from '@eventkit/shared';
import { verifySignedManifest } from '@eventkit/shared/node';
import { placeholderResolvedSet } from '../src/services/manifest/placeholder';
import type { ManifestResolver } from '../src/services/manifest/resolver';
import { startResolve } from '../src/services/manifest/service';
import { addAdmin, adminHeaders, json, keys, loginAdmin, makeApp, type TestApp } from './helpers';

let t: TestApp;
afterEach(async () => t.close());

/** Resolver returning placeholder data with real-looking hashes (no network). */
const fakeResolver: ManifestResolver = {
  async resolve() {
    const set = placeholderResolvedSet();
    set.resolvedAt = new Date().toISOString();
    set.warnings = [];
    set.android = { compileSdk: 35, ndkVersion: '27.0.12077973', flutterVersion: '3.35.4' };
    return set;
  },
};

const getManifest = async (os = 'windows', arch = 'x64') =>
  t.app.inject({ method: 'GET', url: `/api/manifest?os=${os}&arch=${arch}` });

describe('GET /api/manifest', () => {
  it('serves an Ed25519-signed manifest the desktop can verify', async () => {
    t = await makeApp();
    const res = await getManifest();
    expect(res.statusCode).toBe(200);
    const env = json<SignedManifest>(res);
    const m = verifySignedManifest(env, [keys.publicKey], {
      expect: { os: 'windows', arch: 'x64' },
    });
    expect(m.placeholder).toBe(true);
    expect(m.components.map((c) => c.id)).toEqual([
      'system',
      'git',
      'flutter',
      'java',
      'android',
      'chrome',
      'vscode',
      'devtools',
      'warmup',
      'verify',
    ]);
    expect(findComponent(m, 'git')?.artifact?.installArgs).toContain('/VERYSILENT');
  });

  it('includes linux system packages only for linux', async () => {
    t = await makeApp();
    const m = verifySignedManifest(json(await getManifest('linux', 'x64')), [keys.publicKey]);
    expect(findComponent(m, 'linux-deps')?.packages.apt).toContain('libgtk-3-dev');
    expect(findComponent(m, 'chrome')?.linuxPackages?.deb.kind).toBe('deb');
    const mac = verifySignedManifest(json(await getManifest('macos', 'arm64')), [keys.publicKey]);
    expect(findComponent(mac, 'linux-deps')).toBeUndefined();
    expect(findComponent(mac, 'flutter')?.artifact.fileName).toContain('arm64');
  });

  it('rejects unsupported targets', async () => {
    t = await makeApp();
    expect((await getManifest('linux', 'arm64')).statusCode).toBe(503);
    expect((await getManifest('beos', 'x64')).statusCode).toBe(400);
  });

  it('refuses to serve placeholder data when not allowed', async () => {
    t = await makeApp({ env: { MANIFEST_ALLOW_PLACEHOLDER: 'false' } });
    const res = await getManifest();
    expect(res.statusCode).toBe(503);
    expect(json(res).error).toBe('manifest_not_ready');
  });

  it('applies admin settings: pinned version, toggles, mirror, starter project', async () => {
    t = await makeApp({ resolver: fakeResolver, env: { MANIFEST_ALLOW_PLACEHOLDER: 'false' } });
    await startResolve(t.app.ctx);
    await addAdmin(t, 'root@example.org');
    const { cookie } = await loginAdmin(t, 'root@example.org');
    const put = await t.app.inject({
      method: 'PUT',
      url: '/admin/settings',
      headers: adminHeaders(cookie),
      payload: {
        pinnedFlutterVersion: '3.35.4',
        mirrorBaseUrl: 'http://10.0.0.5:8080/mirror',
        components: { android: false },
        minDiskGb: 20,
      },
    });
    expect(put.statusCode).toBe(200);

    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);
    const up = await t.app.inject({
      method: 'POST',
      url: '/admin/settings/starter-project?name=starter_app',
      headers: { ...adminHeaders(cookie), 'content-type': 'application/zip' },
      payload: zip,
    });
    expect(up.statusCode).toBe(200);

    const m = verifySignedManifest(json(await getManifest()), [keys.publicKey]);
    expect(m.placeholder).toBe(false);
    expect(m.mirrorBaseUrl).toBe('http://10.0.0.5:8080/mirror');
    expect(findComponent(m, 'flutter')).toMatchObject({ version: '3.35.4', pinned: true });
    expect(findComponent(m, 'android')?.enabled).toBe(false);
    expect(findComponent(m, 'system')?.minDiskGb).toBe(20);
    // Android defaults adopted from the resolved Flutter template.
    expect(findComponent(m, 'android')?.packages).toContain('platforms;android-35');
    const starter = findComponent(m, 'warmup')?.starter;
    expect(starter?.projectName).toBe('starter_app');
    const dl = await t.app.inject({ method: 'GET', url: new URL(starter!.url).pathname });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(zip)).toBe(true);

    const pinBad = await t.app.inject({
      method: 'PUT',
      url: '/admin/settings',
      headers: adminHeaders(cookie),
      payload: { pinnedFlutterVersion: '9.9.9' },
    });
    expect(pinBad.statusCode).toBe(200);
    expect((await getManifest()).statusCode).toBe(503);
  });

  it('never trusts a manifest if the signature does not match the embedded key', async () => {
    t = await makeApp();
    const env = json<SignedManifest>(await getManifest());
    (env.payload as { mirrorBaseUrl: string }).mirrorBaseUrl = 'http://evil.local';
    expect(() => verifySignedManifest(env, [keys.publicKey])).toThrow(/signature invalid/);
  });
});
