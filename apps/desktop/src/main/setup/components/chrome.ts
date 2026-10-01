import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentOf } from '@eventkit/shared';
import { writable } from '../paths';
import { SetupError, type ComponentContext, type ComponentRunner } from '../types';
import { linuxChromePath } from './linux-deps';
import { COMPONENT_WEIGHTS } from './meta';
import { firstExisting, sh, tryRun, win } from './util';

const MAC_APP = 'Google Chrome.app';

function windowsCandidates() {
  const rel = join('Google', 'Chrome', 'Application', 'chrome.exe');
  return [
    join(win.localAppData(), rel),
    join(win.programFiles(), rel),
    join(win.programFilesX86(), rel),
  ];
}

function macCandidates() {
  return [join('/Applications', MAC_APP), join(homedir(), 'Applications', MAC_APP)].map((a) =>
    join(a, 'Contents', 'MacOS', 'Google Chrome'),
  );
}

export function findChrome(ctx: ComponentContext): string | null {
  if (ctx.platform === 'windows') return firstExisting(windowsCandidates());
  if (ctx.platform === 'macos') return firstExisting(macCandidates());
  return linuxChromePath();
}

/** Locations Flutter finds on its own; anything else needs CHROME_EXECUTABLE. */
function isStandardLocation(ctx: ComponentContext, exePath: string) {
  if (ctx.platform === 'windows') return true;
  if (ctx.platform === 'macos') return exePath.startsWith('/Applications/');
  return exePath.includes('google-chrome') || exePath.startsWith('/opt/google/chrome');
}

async function chromeVersion(ctx: ComponentContext, exePath: string): Promise<string | undefined> {
  if (ctx.platform === 'windows') {
    // chrome.exe --version prints nothing on Windows; the version is the sibling folder name.
    const dir = join(exePath, '..');
    return readdirSync(dir).find((n) => /^\d+\.\d+\.\d+\.\d+$/.test(n));
  }
  const res = await tryRun(ctx, exePath, ['--version'], { timeoutMs: 30_000 });
  return /(\d+\.\d+\.\d+\.\d+)/.exec(res?.stdout ?? '')?.[1];
}

async function waitFor(ctx: ComponentContext, ms: number) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const p = findChrome(ctx);
    if (p) return p;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return null;
}

function configure(ctx: ComponentContext, exePath: string) {
  ctx.facts.chromeExe = exePath;
  if (isStandardLocation(ctx, exePath)) ctx.env.unsetVar('CHROME_EXECUTABLE');
  else ctx.env.setVar('CHROME_EXECUTABLE', exePath);
}

export const chromeRunner: ComponentRunner<ComponentOf<'chrome'>> = {
  id: 'chrome',
  weight: COMPONENT_WEIGHTS.chrome,
  dependsOn: () => ['system', 'linux-deps'],
  artifacts: (c, ctx) =>
    ctx.platform !== 'linux' && c.artifact && !findChrome(ctx) ? [c.artifact] : [],
  async detect(_c, ctx) {
    const p = findChrome(ctx);
    return p
      ? { installed: true, path: p, version: await chromeVersion(ctx, p) }
      : { installed: false };
  },
  async install(c, ctx) {
    if (ctx.platform === 'linux') {
      throw new SetupError(
        'Google Chrome is still missing after installing system packages.',
        'Install Chrome or Chromium, then press Retry.',
      );
    }
    if (!c.artifact) throw new SetupError('No Chrome installer in the manifest');
    ctx.step('download', 'Downloading Google Chrome');
    const file = await ctx.download(c.artifact);

    if (ctx.platform === 'windows') {
      // Per-user standalone installer (needsadmin=false): no UAC prompt.
      ctx.step('install', 'Installing Google Chrome (current user)');
      await sh(ctx, file, c.artifact.installArgs, { timeoutMs: 15 * 60_000, allowFailure: true });
      const p = await waitFor(ctx, 3 * 60_000);
      if (!p) throw new SetupError('Chrome installer finished but chrome.exe was not found');
      configure(ctx, p);
      return;
    }

    // macOS: mount the dmg read-only, copy the app bundle, detach.
    ctx.step('install', 'Copying Google Chrome to Applications');
    const mount = await mkdtemp(join(tmpdir(), 'ek-chrome-'));
    await sh(ctx, '/usr/bin/hdiutil', [
      'attach',
      '-nobrowse',
      '-readonly',
      '-noautoopen',
      '-mountpoint',
      mount,
      file,
    ]);
    try {
      const target = writable('/Applications') ? '/Applications' : join(homedir(), 'Applications');
      await sh(ctx, '/usr/bin/ditto', [join(mount, MAC_APP), join(target, MAC_APP)], {
        timeoutMs: 10 * 60_000,
      });
    } finally {
      await tryRun(ctx, '/usr/bin/hdiutil', ['detach', mount, '-force']);
      await rm(mount, { recursive: true, force: true }).catch(() => undefined);
    }
    const p = findChrome(ctx);
    if (!p) throw new SetupError('Chrome was copied but could not be found');
    configure(ctx, p);
  },
  async verify(_c, ctx) {
    const p = findChrome(ctx);
    if (!p || !existsSync(p)) return { ok: false, detail: 'Google Chrome not found' };
    configure(ctx, p);
    return { ok: true, version: ctx.quick ? undefined : await chromeVersion(ctx, p) };
  },
};
