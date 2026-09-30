import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentId, ManifestComponent, ManifestPayload } from '@eventkit/shared';
import { SetupEngine, type DownloaderLike } from '../src/main/setup/engine';
import { dependsOnFor } from '../src/main/setup/components/meta';
import type { AnyRunner, ComponentContext } from '../src/main/setup/types';

const SHA = 'a'.repeat(64);
const art = (f: string) => ({
  url: `https://x.invalid/${f}`,
  sha256: SHA,
  fileName: f,
  kind: 'zip' as const,
  installArgs: [],
  size: 10,
});

function manifest(
  over: Partial<Record<ComponentId, Partial<ManifestComponent>>> = {},
): ManifestPayload {
  const comps: ManifestComponent[] = [
    { id: 'system', name: 'System', enabled: true, required: true, minDiskGb: 1 },
    { id: 'git', name: 'Git', enabled: true, required: true, minVersion: '2.0.0' },
    {
      id: 'flutter',
      name: 'Flutter',
      enabled: true,
      required: true,
      channel: 'stable',
      version: '3.35.4',
      pinned: false,
      artifact: art('flutter.zip'),
    },
    {
      id: 'java',
      name: 'Java',
      enabled: true,
      required: true,
      majorVersion: 17,
      artifact: art('jdk.zip'),
    },
    {
      id: 'android',
      name: 'Android',
      enabled: true,
      required: true,
      cmdlineTools: art('cl.zip'),
      packages: [],
      acceptLicenses: true,
    },
    { id: 'verify', name: 'Verify', enabled: true, required: true },
  ];
  return {
    schemaVersion: 1,
    manifestId: 'm1',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    event: { slug: 'e', name: 'E' },
    target: { os: 'linux', arch: 'x64' },
    mirrorBaseUrl: null,
    minAppVersion: '0.0.0',
    placeholder: false,
    components: comps.map((c) => ({ ...c, ...(over[c.id] ?? {}) }) as ManifestComponent),
  };
}

/** Fake runners: record installs; "installed" set simulates the machine. */
function fakeRunners(
  machine: Set<ComponentId>,
  installs: ComponentId[],
  failOnce: Set<ComponentId>,
) {
  const runners: Partial<Record<ComponentId, AnyRunner>> = {};
  for (const id of ['system', 'git', 'flutter', 'java', 'android', 'verify'] as ComponentId[]) {
    runners[id] = {
      id,
      weight: 1,
      dependsOn: (c, m) => dependsOnFor(c, m).filter((d) => d !== 'linux-deps'),
      artifacts: (c) => ('artifact' in c && c.artifact ? [c.artifact] : []),
      detect: async (c) => ({ installed: machine.has(c.id) }),
      install: async (c, ctx: ComponentContext) => {
        for (const a of 'artifact' in c && c.artifact ? [c.artifact] : []) await ctx.download(a);
        installs.push(c.id);
        if (failOnce.has(c.id)) {
          failOnce.delete(c.id);
          throw new Error(`${c.id} exploded`);
        }
        machine.add(c.id);
      },
      verify: async (c) => ({ ok: machine.has(c.id), version: '1.0' }),
    };
  }
  return runners;
}

let dir: string;
let machine: Set<ComponentId>;
let installs: ComponentId[];
let failOnce: Set<ComponentId>;
let downloads: string[];
let m: ManifestPayload;
let completed = 0;

const downloader: DownloaderLike = {
  async download(req) {
    downloads.push(req.label);
    return req.dest;
  },
};

function makeEngine() {
  return new SetupEngine({
    platform: 'linux',
    arch: 'x64',
    statePath: join(dir, 'state.json'),
    envStatePath: join(dir, 'env.json'),
    runners: fakeRunners(machine, installs, failOnce),
    manifestSource: { load: async () => ({ manifest: m, fromCache: false }) },
    downloader,
    exec: { run: async () => ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false }) },
    persistEnv: async () => undefined,
    simulate: false,
    elevateDelayMs: 0,
    onComplete: async () => {
      completed++;
    },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ek-engine-'));
  process.env['HOME'] = dir;
  process.env['USERPROFILE'] = dir;
  machine = new Set();
  installs = [];
  failOnce = new Set();
  downloads = [];
  m = manifest();
  completed = 0;
});

describe('SetupEngine', () => {
  it('installs everything in order and completes', async () => {
    const e = makeEngine();
    await e.start();
    const s = e.snapshot();
    expect(s.complete).toBe(true);
    expect(s.overallPercent).toBe(100);
    expect(installs).toEqual(['system', 'git', 'flutter', 'java', 'android', 'verify']);
    expect(downloads.sort()).toEqual(['flutter.zip', 'jdk.zip']);
    expect(completed).toBe(1);
  });

  it('skips components that are already installed and valid (idempotent)', async () => {
    machine = new Set(['system', 'git', 'flutter']);
    const e = makeEngine();
    await e.start();
    expect(installs).toEqual(['java', 'android', 'verify']);
    expect(downloads).not.toContain('flutter.zip');
    installs.length = 0;
    await makeEngine().start();
    expect(installs).toEqual([]);
    expect(completed).toBe(2);
  });

  it('marks a failure, blocks dependents, and resumes on retry', async () => {
    failOnce.add('flutter');
    const e = makeEngine();
    await e.start();
    let s = e.snapshot();
    const byId = Object.fromEntries(s.components.map((c) => [c.id, c]));
    expect(s.complete).toBe(false);
    expect(byId['flutter']!.status).toBe('failed');
    expect(byId['flutter']!.error).toMatch(/exploded/);
    expect(byId['android']!.status).toBe('pending');
    expect(byId['android']!.message).toMatch(/Waiting for Flutter SDK/);
    expect(byId['java']!.status).toBe('verified'); // independent components still install
    expect(completed).toBe(0);

    installs.length = 0;
    await e.retry('flutter');
    s = e.snapshot();
    expect(s.complete).toBe(true);
    expect(installs).toEqual(['flutter', 'android', 'verify']);
  });

  it('persists state across restarts (resume after crash)', async () => {
    failOnce.add('android');
    await makeEngine().start();
    const again = makeEngine();
    expect(again.componentStates()['android']?.status).toBe('failed');
    expect(again.componentStates()['flutter']?.status).toBe('verified');
    installs.length = 0;
    await again.start();
    expect(installs).toEqual(['android', 'verify']);
    expect(again.isComplete).toBe(true);
  });

  it('respects disabled components', async () => {
    m = manifest({
      android: { enabled: false, required: false },
      java: { enabled: false, required: false },
    });
    const e = makeEngine();
    await e.start();
    const byId = Object.fromEntries(e.snapshot().components.map((c) => [c.id, c.status]));
    expect(byId['android']).toBe('disabled');
    expect(installs).not.toContain('android');
    expect(e.isComplete).toBe(true);
  });

  it('refuses placeholder manifests outside simulate mode', async () => {
    m = { ...manifest(), placeholder: true };
    const e = makeEngine();
    await e.start();
    expect(e.snapshot().error).toMatch(/not published/);
    expect(installs).toEqual([]);
  });

  it('reverify detects a component that disappeared', async () => {
    const e = makeEngine();
    await e.start();
    machine.delete('java');
    const ok = await e.reverify({ includeDoctor: false });
    expect(ok).toBe(false);
    expect(e.isComplete).toBe(false);
    expect(e.snapshot().components.find((c) => c.id === 'java')!.status).toBe('failed');
  });
});
