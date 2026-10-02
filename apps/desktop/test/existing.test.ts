import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentOf, Platform } from '@eventkit/shared';
import {
  adopt,
  findExistingAndroidSdk,
  findExistingFlutter,
  findExistingJdk,
  release,
} from '../src/main/setup/components/existing';
import { installDirs } from '../src/main/setup/paths';
import type { ComponentContext } from '../src/main/setup/types';

const platform: Platform =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

let dir: string;
/** Fake tool output by executable path; anything else fails to run. */
let outputs: Map<string, { stdout?: string; stderr?: string }>;

function touchExe(p: string) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '');
  chmodSync(p, 0o755);
}

function makeCtx(): ComponentContext {
  const noop = () => undefined;
  return {
    platform,
    arch: 'x64',
    dirs: installDirs(join(dir, 'toolchain')),
    facts: {},
    env: { childEnv: () => ({}) },
    log: { info: noop, warn: noop, error: noop, debug: noop },
    exec: {
      run: async (file: string) => {
        const out = outputs.get(file);
        return {
          code: out ? 0 : 1,
          signal: null,
          stdout: out?.stdout ?? '',
          stderr: out?.stderr ?? '',
          timedOut: false,
        };
      },
    },
    signal: new AbortController().signal,
    save: noop,
  } as unknown as ComponentContext;
}

const flutterComponent = (over: Partial<ComponentOf<'flutter'>> = {}) =>
  ({ id: 'flutter', version: '3.47.6', pinned: false, ...over }) as ComponentOf<'flutter'>;
const javaComponent = { id: 'java', majorVersion: 17 } as ComponentOf<'java'>;

function fakeFlutter(channel: string, version = '3.44.6') {
  const root = join(dir, 'flutter');
  const bin = join(root, 'bin', platform === 'windows' ? 'flutter.bat' : 'flutter');
  touchExe(bin);
  const out = { stdout: JSON.stringify({ frameworkVersion: version, channel, flutterRoot: root }) };
  // The finder resolves symlinks / 8.3 names (macOS /private/var, Windows RUNNER~1).
  outputs.set(bin, out).set(realpathSync(bin), out);
  return { root, env: { PATH: join(root, 'bin') } };
}

function fakeJdk(version: string) {
  const root = join(dir, 'jdk');
  const home = platform === 'macos' ? join(root, 'Contents', 'Home') : root;
  const java = join(home, 'bin', platform === 'windows' ? 'java.exe' : 'java');
  touchExe(java);
  outputs.set(java, { stderr: `openjdk version "${version}" 2025-07-15` });
  return { root, env: { JAVA_HOME: home } };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ek-existing-'));
  outputs = new Map();
});

describe('reusing existing toolchains', () => {
  it('adopts a stable Flutter found on PATH', async () => {
    const { root, env } = fakeFlutter('stable');
    expect(await findExistingFlutter(flutterComponent(), makeCtx(), env)).toBe(root);
  });

  it('skips a Flutter on another channel or not at the pinned version', async () => {
    const beta = fakeFlutter('beta');
    expect(await findExistingFlutter(flutterComponent(), makeCtx(), beta.env)).toBeNull();
    const stable = fakeFlutter('stable', '3.44.6');
    const pinned = flutterComponent({ pinned: true, version: '3.47.6' });
    expect(await findExistingFlutter(pinned, makeCtx(), stable.env)).toBeNull();
  });

  it('adopts a JDK from JAVA_HOME only within the supported versions', async () => {
    const ok = fakeJdk('21.0.8');
    expect(await findExistingJdk(javaComponent, makeCtx(), ok.env)).toBe(ok.root);
    const tooNew = fakeJdk('25.0.1');
    expect(await findExistingJdk(javaComponent, makeCtx(), tooNew.env)).toBeNull();
    const tooOld = fakeJdk('11.0.2');
    expect(await findExistingJdk(javaComponent, makeCtx(), tooOld.env)).toBeNull();
  });

  it('adopts an Android SDK but not one on a path with spaces', () => {
    const sdk = join(dir, 'sdk');
    mkdirSync(join(sdk, 'platforms'), { recursive: true });
    expect(findExistingAndroidSdk(makeCtx(), { ANDROID_HOME: sdk })).toBe(sdk);
    const spaced = join(dir, 'my sdk');
    mkdirSync(join(spaced, 'platforms'), { recursive: true });
    expect(findExistingAndroidSdk(makeCtx(), { ANDROID_HOME: spaced })).not.toBe(spaced);
  });

  it('installs into the managed folder after releasing an adopted one', () => {
    const ctx = makeCtx();
    const managed = ctx.dirs.flutter;
    adopt(ctx, 'flutter', join(dir, 'flutter'));
    expect(ctx.dirs.flutter).toBe(join(dir, 'flutter'));
    expect(installDirs(ctx.dirs.root, ctx.facts.adopted).flutter).toBe(join(dir, 'flutter'));
    release(ctx, 'flutter');
    expect(ctx.dirs.flutter).toBe(managed);
    expect(ctx.facts.adopted).toEqual({});
  });
});
