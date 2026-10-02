import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { majorOf, type ComponentOf } from '@eventkit/shared';
import { which } from '../exec';
import { bat, exe, installDirs, pathProblem } from '../paths';
import type { AdoptedDirs, ComponentContext } from '../types';
import { jsonFromOutput, tryRun, type FlutterVersionInfo } from './util';

/**
 * Reuse toolchains the attendee already has (their own Flutter, Android Studio's JDK and
 * SDK) instead of downloading a second copy. An existing install is only adopted when it
 * already meets the event's requirements; otherwise the managed copy is installed.
 */

/** Newest JDK that Flutter's Android Gradle setup is known to build with. */
export const MAX_JAVA_MAJOR = 21;

/** Use an existing install for `key` from now on (persisted in facts). */
export function adopt(ctx: ComponentContext, key: keyof AdoptedDirs, path: string) {
  ctx.dirs[key] = path;
  ctx.facts.adopted = { ...ctx.facts.adopted, [key]: path };
  ctx.log.info(`using existing ${key} at ${path}`);
  ctx.save();
}

/** Go back to the managed location before installing, so we never write over the user's copy. */
export function release(ctx: ComponentContext, key: keyof AdoptedDirs) {
  if (!ctx.facts.adopted?.[key]) return;
  const { [key]: _dropped, ...rest } = ctx.facts.adopted;
  ctx.facts.adopted = rest;
  ctx.dirs[key] = installDirs(ctx.dirs.root)[key];
  ctx.save();
}

const unique = (xs: Array<string | undefined | null>) => [
  ...new Set(xs.filter((x): x is string => Boolean(x))),
];

function real(p: string) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** A stable Flutter on PATH or in FLUTTER_ROOT (exactly the pinned version, if one is set). */
export async function findExistingFlutter(
  c: ComponentOf<'flutter'>,
  ctx: ComponentContext,
  env = process.env,
): Promise<string | null> {
  const onPath = await which('flutter', env['PATH'] ?? env['Path'] ?? '');
  const bins = unique([
    env['FLUTTER_ROOT'] && join(env['FLUTTER_ROOT'], 'bin', bat(ctx.platform, 'flutter')),
    onPath && real(onPath),
  ]);
  for (const bin of bins) {
    if (!existsSync(bin)) continue;
    const res = await tryRun(ctx, bin, ['--version', '--machine'], { timeoutMs: 5 * 60_000 });
    const info = res?.code === 0 ? jsonFromOutput<FlutterVersionInfo>(res.stdout) : null;
    if (!info?.frameworkVersion) continue;
    const root = info.flutterRoot ?? dirname(dirname(bin));
    if (!existsSync(join(root, 'bin', bat(ctx.platform, 'flutter')))) continue;
    const skip =
      pathProblem(root) ??
      (info.channel !== 'stable' ? `channel ${info.channel}` : null) ??
      (c.pinned && info.frameworkVersion !== c.version
        ? `version ${info.frameworkVersion}, event requires ${c.version}`
        : null);
    if (skip) {
      ctx.log.info(`not using Flutter at ${root}: ${skip}`);
      continue;
    }
    return root;
  }
  return null;
}

/** Where Android Studio keeps its bundled JDK, as the folder `dirs.jdk` expects. */
function androidStudioJdks(platform: ComponentContext['platform'], env: NodeJS.ProcessEnv) {
  const home = homedir();
  if (platform === 'windows') {
    return [
      join(env['ProgramFiles'] ?? 'C:\\Program Files', 'Android', 'Android Studio', 'jbr'),
      env['LOCALAPPDATA'] && join(env['LOCALAPPDATA'], 'Programs', 'Android Studio', 'jbr'),
    ];
  }
  if (platform === 'macos') {
    return [
      '/Applications/Android Studio.app/Contents/jbr',
      join(home, 'Applications', 'Android Studio.app', 'Contents', 'jbr'),
    ];
  }
  return [
    '/opt/android-studio/jbr',
    join(home, 'android-studio', 'jbr'),
    '/snap/android-studio/current/jbr',
  ];
}

/** `dirs.jdk` for a JAVA_HOME-style path (macOS bundles keep the JDK in Contents/Home). */
function jdkRootFromHome(home: string, platform: ComponentContext['platform']) {
  if (platform !== 'macos') return home;
  const m = /^(.*)[\\/]Contents[\\/]Home[\\/]?$/.exec(home);
  return m ? m[1]! : null;
}

/** A JDK between the required major version and MAX_JAVA_MAJOR. */
export async function findExistingJdk(
  c: ComponentOf<'java'>,
  ctx: ComponentContext,
  env = process.env,
): Promise<string | null> {
  const onPath = await which('java', env['PATH'] ?? env['Path'] ?? '');
  const homes = unique([
    env['JAVA_HOME'] && jdkRootFromHome(env['JAVA_HOME'], ctx.platform),
    ...androidStudioJdks(ctx.platform, env),
    onPath && jdkRootFromHome(dirname(dirname(real(onPath))), ctx.platform),
  ]);
  for (const root of homes) {
    const javaHome = ctx.platform === 'macos' ? join(root, 'Contents', 'Home') : root;
    const java = join(javaHome, 'bin', exe(ctx.platform, 'java'));
    if (!existsSync(java)) continue;
    const res = await tryRun(ctx, java, ['-version'], { timeoutMs: 60_000 });
    const version = /version "([\d._+]+)"/.exec(`${res?.stderr ?? ''}${res?.stdout ?? ''}`)?.[1];
    const major = version ? (majorOf(version) ?? 0) : 0;
    if (major < c.majorVersion || major > MAX_JAVA_MAJOR) {
      if (version) ctx.log.info(`not using Java ${version} at ${root}`);
      continue;
    }
    return root;
  }
  return null;
}

/** An Android SDK from ANDROID_HOME/ANDROID_SDK_ROOT or Android Studio's default location. */
export function findExistingAndroidSdk(ctx: ComponentContext, env = process.env): string | null {
  const home = homedir();
  const defaults =
    ctx.platform === 'windows'
      ? [env['LOCALAPPDATA'] && join(env['LOCALAPPDATA'], 'Android', 'Sdk')]
      : ctx.platform === 'macos'
        ? [join(home, 'Library', 'Android', 'sdk')]
        : [join(home, 'Android', 'Sdk')];
  for (const sdk of unique([env['ANDROID_HOME'], env['ANDROID_SDK_ROOT'], ...defaults])) {
    const looksLikeSdk = ['platform-tools', 'platforms', 'build-tools', 'cmdline-tools'].some((d) =>
      existsSync(join(sdk, d)),
    );
    if (!looksLikeSdk) continue;
    // Flutter and the NDK break on paths with spaces or unusual characters.
    const problem = pathProblem(sdk);
    if (problem) {
      ctx.log.info(`not using Android SDK at ${sdk}: ${problem}`);
      continue;
    }
    return sdk;
  }
  return null;
}
