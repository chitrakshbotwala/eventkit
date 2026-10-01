import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Platform } from '@eventkit/shared';
import type { InstallDirs } from './types';

/**
 * Flutter, Gradle and the Android tools break on paths with spaces or
 * non-ASCII characters, and our cmd.exe wrapper rejects shell metacharacters.
 * Allowed: printable ASCII without space and without & | < > ^ % ! " ' ` ( ) ;
 */
const SAFE_PATH = /^[A-Za-z0-9._\-/\\:~+@#$=,[\]{}]+$/;

export function pathProblem(p: string): string | null {
  if (/\s/.test(p)) return 'contains spaces';
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7F]/.test(p)) return 'contains non-ASCII characters';
  if (!SAFE_PATH.test(p)) return 'contains special characters';
  return null;
}

export function writable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    const probe = join(dir, `.eventkit-write-test-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export interface RootChoice {
  root: string | null;
  tried: Array<{ path: string; problem: string }>;
}

/** Candidate install roots in order of preference. */
export function rootCandidates(platform: Platform, env = process.env, home = homedir()): string[] {
  if (platform === 'windows') {
    const drive = env['SystemDrive'] ?? 'C:';
    return [
      join(`${drive}\\`, 'dev', 'toolchain'),
      join(env['USERPROFILE'] ?? home, 'dev', 'toolchain'),
    ];
  }
  return [join(home, 'dev', 'toolchain')];
}

export function chooseInstallRoot(platform: Platform, previous?: string | null): RootChoice {
  const tried: RootChoice['tried'] = [];
  const candidates = previous ? [previous, ...rootCandidates(platform)] : rootCandidates(platform);
  for (const c of candidates) {
    const problem = pathProblem(c);
    if (problem) {
      tried.push({ path: c, problem });
      continue;
    }
    if (!writable(c)) {
      tried.push({ path: c, problem: 'not writable' });
      continue;
    }
    return { root: c, tried };
  }
  return { root: null, tried };
}

export function installDirs(root: string): InstallDirs {
  return {
    root,
    flutter: join(root, 'flutter'),
    jdk: join(root, 'jdk-17'),
    androidSdk: join(root, 'android-sdk'),
    vscode: join(root, 'vscode'),
    downloads: join(root, '.downloads'),
    staging: join(root, '.staging'),
    projects: join(dirname(root), 'projects'),
  };
}

export const exe = (platform: Platform, name: string) =>
  platform === 'windows' ? `${name}.exe` : name;
export const bat = (platform: Platform, name: string) =>
  platform === 'windows' ? `${name}.bat` : name;

export function flutterBin(dirs: InstallDirs, platform: Platform) {
  return join(dirs.flutter, 'bin', bat(platform, 'flutter'));
}

export function dartExe(dirs: InstallDirs, platform: Platform) {
  return join(dirs.flutter, 'bin', 'cache', 'dart-sdk', 'bin', exe(platform, 'dart'));
}

/** JAVA_HOME inside our JDK folder (macOS JDKs nest under Contents/Home). */
export function javaHome(dirs: InstallDirs, platform: Platform) {
  return platform === 'macos' ? join(dirs.jdk, 'Contents', 'Home') : dirs.jdk;
}

export function sdkmanager(dirs: InstallDirs, platform: Platform) {
  return join(dirs.androidSdk, 'cmdline-tools', 'latest', 'bin', bat(platform, 'sdkmanager'));
}
