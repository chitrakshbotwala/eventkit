import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComponentOf } from '@eventkit/shared';
import { extractArchive, replaceDir } from '../extract';
import { exe, javaHome, sdkmanager } from '../paths';
import { SetupError, type ComponentContext, type ComponentRunner } from '../types';
import { adopt, findExistingAndroidSdk } from './existing';
import { COMPONENT_WEIGHTS } from './meta';
import { flutter, hasFlutter, sh, tryRun, yesResponder } from './util';

function configureEnv(ctx: ComponentContext) {
  const sdk = ctx.dirs.androidSdk;
  ctx.env.setVar('ANDROID_HOME', sdk);
  ctx.env.setVar('ANDROID_SDK_ROOT', sdk);
  ctx.env.addPath(join(sdk, 'platform-tools'));
  ctx.env.addPath(join(sdk, 'cmdline-tools', 'latest', 'bin'));
  ctx.facts.androidSdk = sdk;
}

/** sdkmanager's Java networking ignores system proxies: pass them explicitly. */
function proxyArgs(ctx: ComponentContext): string[] {
  if (!ctx.facts.proxy) return [];
  const u = new URL(ctx.facts.proxy);
  return ['--proxy=http', `--proxy_host=${u.hostname}`, `--proxy_port=${u.port || '80'}`];
}

function sdkArgs(ctx: ComponentContext) {
  return [`--sdk_root=${ctx.dirs.androidSdk}`, ...proxyArgs(ctx)];
}

/** Parse `sdkmanager --list_installed` into package paths. */
/**
 * Package ids from `sdkmanager --list_installed`, in the `;` form the manifest uses.
 * Two output formats exist:
 * - classic table:  `  build-tools;36.0.0 | 36.0.0 | Android SDK Build-Tools 36 | build-tools\36.0.0`
 * - cmdline-tools 23+, where sdkmanager hands off to the `android` CLI:
 *   `  build-tools/36.0.0      36.0.0      Android SDK Build-Tools 36`
 */
export function parseInstalled(out: string): Set<string> {
  const set = new Set<string>();
  let installedSection = true;
  // The android CLI colours each package line, even when its output is piped.
  // eslint-disable-next-line no-control-regex
  const plain = out.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
  for (const line of plain.split(/\r?\n/)) {
    // Section headers ("Installed packages:", "Available Updates:") are unindented.
    if (/^\S.*:\s*$/.test(line)) {
      installedSection = /^installed packages:/i.test(line);
      continue;
    }
    if (!installedSection) continue;
    const m = /^\s{1,4}([a-z][\w.;/-]*)\s+(?:\|\s+)?[\w.-]+/i.exec(line);
    if (m && m[1] !== 'Path') set.add(m[1]!.replace(/\//g, ';'));
  }
  return set;
}

async function installedPackages(ctx: ComponentContext): Promise<Set<string> | null> {
  const bin = sdkmanager(ctx.dirs, ctx.platform);
  if (!existsSync(bin)) return null;
  const res = await tryRun(ctx, bin, ['--list_installed', ...sdkArgs(ctx)], {
    timeoutMs: 3 * 60_000,
  });
  return res?.code === 0 ? parseInstalled(res.stdout) : null;
}

function licensesAccepted(ctx: ComponentContext) {
  return existsSync(join(ctx.dirs.androidSdk, 'licenses', 'android-sdk-license'));
}

async function acceptLicenses(ctx: ComponentContext) {
  ctx.step('configure', 'Accepting Android SDK licenses');
  const respond = yesResponder(ctx);
  if (hasFlutter(ctx)) {
    const res = await tryRun(
      ctx,
      join(ctx.dirs.flutter, 'bin', ctx.platform === 'windows' ? 'flutter.bat' : 'flutter'),
      ['doctor', '--android-licenses'],
      {
        respond,
        timeoutMs: 10 * 60_000,
        onLine: (l) => ctx.log.debug(`  licenses: ${l}`),
      },
    );
    if (res?.code === 0 && licensesAccepted(ctx)) {
      ctx.facts.licensesAcceptedFor = ctx.dirs.androidSdk;
      ctx.save();
      return;
    }
    ctx.log.warn(
      'flutter doctor --android-licenses did not complete; falling back to sdkmanager --licenses',
    );
  }
  await sh(ctx, sdkmanager(ctx.dirs, ctx.platform), ['--licenses', ...sdkArgs(ctx)], {
    respond,
    timeoutMs: 10 * 60_000,
  });
  ctx.facts.licensesAcceptedFor = ctx.dirs.androidSdk;
  ctx.save();
}

export const androidRunner: ComponentRunner<ComponentOf<'android'>> = {
  id: 'android',
  weight: COMPONENT_WEIGHTS.android,
  dependsOn: () => ['java', 'flutter'],
  artifacts: (c, ctx) => (existsSync(sdkmanager(ctx.dirs, ctx.platform)) ? [] : [c.cmdlineTools]),
  async detect(c, ctx) {
    // An existing SDK is kept even when packages are missing: install adds only those.
    if (!existsSync(ctx.dirs.androidSdk)) {
      const existing = findExistingAndroidSdk(ctx);
      if (existing) adopt(ctx, 'androidSdk', existing);
    }
    const installed = await installedPackages(ctx);
    if (!installed) return { installed: false };
    const missing = c.packages.filter((p) => !installed.has(p));
    // An existing SDK (Android Studio's) often has only some licenses accepted, which
    // flutter doctor reports as a failure: accept them all once, as setup does for its own.
    const licensesDone =
      licensesAccepted(ctx) &&
      (!c.acceptLicenses || ctx.facts.licensesAcceptedFor === ctx.dirs.androidSdk);
    return {
      installed: missing.length === 0 && licensesDone,
      detail: [...missing, ...(licensesDone ? [] : ['licenses'])].join(' '),
    };
  },
  async install(c, ctx) {
    configureEnv(ctx);
    const bin = sdkmanager(ctx.dirs, ctx.platform);
    if (!existsSync(bin)) {
      ctx.step('download', 'Downloading Android command-line tools');
      const archive = await ctx.download(c.cmdlineTools);
      ctx.step('install', 'Extracting command-line tools');
      const staging = join(ctx.dirs.staging, 'cmdline-tools');
      await extractArchive(archive, staging, 'zip', ctx.platform, { signal: ctx.signal });
      if (!existsSync(join(staging, 'cmdline-tools', 'bin')))
        throw new SetupError('cmdline-tools archive layout unexpected');
      await mkdir(join(ctx.dirs.androidSdk, 'cmdline-tools'), { recursive: true });
      await replaceDir(
        join(staging, 'cmdline-tools'),
        join(ctx.dirs.androidSdk, 'cmdline-tools', 'latest'),
      );
    }
    ctx.progress({ percent: 65 });

    if (hasFlutter(ctx)) {
      await flutter(ctx, ['config', `--android-sdk=${ctx.dirs.androidSdk}`]);
      if (ctx.facts.javaHome)
        await flutter(ctx, ['config', `--jdk-dir=${javaHome(ctx.dirs, ctx.platform)}`]);
    }
    if (c.acceptLicenses) await acceptLicenses(ctx);
    ctx.progress({ percent: 70 });

    ctx.step('install', `Installing ${c.packages.join(', ')}`);
    await sh(ctx, bin, ['--install', ...c.packages, ...sdkArgs(ctx)], {
      respond: yesResponder(ctx),
      timeoutMs: 60 * 60_000,
      onLine: (l) => {
        const m = /(\d{1,3})%/.exec(l);
        if (m)
          ctx.progress({
            percent: 70 + Math.round(Number(m[1]) * 0.25),
            message: l
              .replace(/\[=*\s*\]/, '')
              .trim()
              .slice(0, 120),
          });
      },
    });
    if (c.acceptLicenses) await acceptLicenses(ctx);
  },
  async verify(c, ctx) {
    configureEnv(ctx);
    if (!existsSync(sdkmanager(ctx.dirs, ctx.platform)))
      return { ok: false, detail: 'Android command-line tools not found' };
    if (!licensesAccepted(ctx)) return { ok: false, detail: 'Android SDK licenses not accepted' };
    const adb = join(ctx.dirs.androidSdk, 'platform-tools', exe(ctx.platform, 'adb'));
    if (!existsSync(adb)) return { ok: false, detail: 'platform-tools (adb) missing' };
    if (ctx.quick) {
      const missing = c.packages.filter(
        (p) => !existsSync(join(ctx.dirs.androidSdk, ...p.split(';'))),
      );
      return missing.length
        ? { ok: false, detail: `missing ${missing.join(', ')}` }
        : { ok: true, version: c.packages.find((p) => p.startsWith('platforms;'))?.split(';')[1] };
    }
    const installed = await installedPackages(ctx);
    if (!installed) return { ok: false, detail: 'sdkmanager --list_installed failed' };
    const missing = c.packages.filter((p) => !installed.has(p));
    if (missing.length) return { ok: false, detail: `missing ${missing.join(', ')}` };
    return { ok: true, version: c.packages.find((p) => p.startsWith('platforms;'))?.split(';')[1] };
  },
};
