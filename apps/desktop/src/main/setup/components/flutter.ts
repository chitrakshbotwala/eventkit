import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentOf } from '@eventkit/shared';
import { extractArchive, replaceDir, singleChild } from '../extract';
import { flutterBin } from '../paths';
import { SetupError, type ComponentContext, type ComponentRunner } from '../types';
import { COMPONENT_WEIGHTS } from './meta';
import { flutter, flutterVersion, hasFlutter, sh, tryRun } from './util';

/**
 * Some Flutter tooling still needs Rosetta 2 on Apple Silicon. Best effort: a
 * failure (or the user declining the password prompt) is logged, not fatal.
 */
async function ensureRosetta(ctx: ComponentContext) {
  const probe = await tryRun(ctx, '/usr/bin/arch', ['-x86_64', '/usr/bin/true'], {
    timeoutMs: 20_000,
  });
  if (probe?.code === 0) return;
  await ctx.elevate(
    "Flutter needs Apple's Rosetta 2 on this Mac. macOS will ask for your password to install it.",
  );
  const res = await tryRun(
    ctx,
    '/usr/bin/osascript',
    [
      '-e',
      'do shell script "/usr/sbin/softwareupdate --install-rosetta --agree-to-license" with administrator privileges',
    ],
    { timeoutMs: 20 * 60_000 },
  );
  if (res?.code !== 0) ctx.log.warn('Rosetta 2 installation failed or was declined; continuing');
}

export const flutterRunner: ComponentRunner<ComponentOf<'flutter'>> = {
  id: 'flutter',
  weight: COMPONENT_WEIGHTS.flutter,
  dependsOn: () => ['git'],
  artifacts: (c) => [c.artifact],
  async detect(_c, ctx) {
    if (!hasFlutter(ctx)) return { installed: false };
    const v = await flutterVersion(ctx);
    return v
      ? { installed: true, version: v.frameworkVersion, path: ctx.dirs.flutter }
      : { installed: false, detail: 'flutter present but not runnable' };
  },
  async install(c, ctx) {
    ctx.step('download', `Downloading Flutter ${c.version}`);
    const archive = await ctx.download(c.artifact);
    ctx.step('verify-hash', 'SHA-256 verified');

    ctx.step('install', 'Extracting Flutter SDK (this takes a few minutes)…');
    ctx.progress({ percent: 62 });
    const staging = join(ctx.dirs.staging, 'flutter');
    await extractArchive(archive, staging, c.artifact.kind, ctx.platform, { signal: ctx.signal });
    const extracted = existsSync(join(staging, 'flutter'))
      ? join(staging, 'flutter')
      : await singleChild(staging);
    if (!existsSync(join(extracted, 'bin')))
      throw new SetupError('Flutter archive layout unexpected (no bin folder)');
    await replaceDir(extracted, ctx.dirs.flutter);
    ctx.progress({ percent: 75 });

    ctx.step('configure', 'Configuring Flutter');
    ctx.env.addPath(join(ctx.dirs.flutter, 'bin'));
    ctx.facts.flutterRoot = ctx.dirs.flutter;
    ctx.save();
    // Git may refuse to operate on a repo created by another user id (e.g. extracted by an installer).
    if (ctx.facts.gitExe) {
      await sh(ctx, ctx.facts.gitExe, [
        'config',
        '--global',
        '--add',
        'safe.directory',
        ctx.dirs.flutter.replace(/\\/g, '/'),
      ]).catch(() => undefined);
    }
    if (ctx.platform === 'macos' && ctx.arch === 'arm64') await ensureRosetta(ctx);
    await flutter(ctx, ['config', '--no-analytics'], { timeoutMs: 10 * 60_000 });
    await flutter(ctx, ['--disable-analytics'], { allowFailure: true });
    ctx.progress({
      percent: 80,
      message: 'Downloading Flutter engine artifacts (flutter precache)…',
    });
    await flutter(ctx, ['precache'], {
      timeoutMs: 45 * 60_000,
      onLine: (l) => {
        ctx.log.debug(`  flutter: ${l}`);
        if (/Downloading|Updating/.test(l)) ctx.progress({ message: l.trim().slice(0, 120) });
      },
    });
    ctx.progress({ percent: 95 });
  },
  async verify(c, ctx) {
    if (!existsSync(flutterBin(ctx.dirs, ctx.platform)))
      return { ok: false, detail: 'Flutter SDK not found' };
    ctx.env.addPath(join(ctx.dirs.flutter, 'bin'));
    ctx.facts.flutterRoot = ctx.dirs.flutter;
    const v = await flutterVersion(ctx);
    if (!v) return { ok: false, detail: 'flutter --version failed' };
    if (v.channel !== 'stable')
      return {
        ok: false,
        version: v.frameworkVersion,
        detail: `channel ${v.channel}, expected stable`,
      };
    if (c.pinned && v.frameworkVersion !== c.version) {
      return {
        ok: false,
        version: v.frameworkVersion,
        detail: `Flutter ${v.frameworkVersion} installed, event requires ${c.version}`,
      };
    }
    return { ok: true, version: v.frameworkVersion };
  },
};
