import { describe, expect, it } from 'vitest';
import {
  BLOCK_END,
  BLOCK_START,
  encodePowerShell,
  removeBlock,
  renderFishBlock,
  renderPosixBlock,
  upsertBlock,
  WINDOWS_ENV_SCRIPT,
} from '../src/main/setup/env-persist';
import { EnvOverlay } from '../src/main/setup/env-overlay';
import { batchCommandLine, quoteCmdArg } from '../src/main/setup/exec';
import { pathProblem } from '../src/main/setup/paths';

const env = {
  path: ['/home/a/dev/toolchain/flutter/bin', '/home/a/dev/toolchain/jdk-17/bin'],
  vars: {
    JAVA_HOME: '/home/a/dev/toolchain/jdk-17',
    ANDROID_HOME: '/home/a/dev/toolchain/android-sdk',
  },
};

describe('managed shell block', () => {
  it('renders exports and PATH', () => {
    const b = renderPosixBlock(env);
    expect(b.split('\n')[0]).toBe(BLOCK_START);
    expect(b).toContain('export ANDROID_HOME="/home/a/dev/toolchain/android-sdk"');
    expect(b).toContain(
      'export PATH="/home/a/dev/toolchain/flutter/bin:/home/a/dev/toolchain/jdk-17/bin:$PATH"',
    );
    expect(b.trim().endsWith(BLOCK_END)).toBe(true);
  });

  it('escapes shell metacharacters in values', () => {
    const b = renderPosixBlock({
      path: [],
      vars: { CHROME_EXECUTABLE: '/Users/a/Applications/Google Chrome.app/$x`y"z' },
    });
    expect(b).toContain(
      'export CHROME_EXECUTABLE="/Users/a/Applications/Google Chrome.app/\\$x\\`y\\"z"',
    );
  });

  it('rejects invalid variable names', () => {
    expect(() => renderPosixBlock({ path: [], vars: { 'A;rm -rf': 'x' } })).toThrow();
  });

  it('is idempotent and preserves user content', () => {
    const user = '# my config\nalias ll="ls -la"\n';
    const once = upsertBlock(user, renderPosixBlock(env));
    const twice = upsertBlock(once, renderPosixBlock(env));
    expect(twice).toBe(once);
    expect(once.startsWith(user)).toBe(true);
    const changed = upsertBlock(once, renderPosixBlock({ ...env, vars: { JAVA_HOME: '/new' } }));
    expect(changed.match(new RegExp(BLOCK_START.replace(/[()]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(changed).toContain('/new');
    expect(changed).not.toContain('ANDROID_HOME');
    expect(removeBlock(changed).trim()).toBe(user.trim());
  });

  it('renders fish syntax', () => {
    const b = renderFishBlock(env);
    expect(b).toContain("set -gx JAVA_HOME '/home/a/dev/toolchain/jdk-17'");
    expect(b).toContain("fish_add_path --global --prepend '/home/a/dev/toolchain/flutter/bin'");
    // highest priority entry is added last so it ends up first
    expect(b.indexOf('jdk-17/bin')).toBeLessThan(b.indexOf('flutter/bin'));
  });
});

describe('Windows env script', () => {
  it('never uses setx and encodes as UTF-16LE base64', () => {
    expect(WINDOWS_ENV_SCRIPT).not.toMatch(/setx/i);
    expect(WINDOWS_ENV_SCRIPT).toContain('DoNotExpandEnvironmentNames');
    expect(WINDOWS_ENV_SCRIPT).toContain('ExpandString');
    expect(WINDOWS_ENV_SCRIPT).toContain("TrimEnd('\\')");
    expect(Buffer.from(encodePowerShell('ab'), 'base64')).toEqual(Buffer.from([97, 0, 98, 0]));
  });
});

describe('EnvOverlay', () => {
  it('prepends PATH entries and sets variables for child processes', () => {
    const o = new EnvOverlay();
    o.addPath('/t/flutter/bin');
    o.addPath('/t/flutter/bin');
    o.setVar('JAVA_HOME', '/t/jdk');
    const child = o.childEnv({ PATH: '/usr/bin' });
    const sep = process.platform === 'win32' ? ';' : ':';
    expect(child['PATH']).toBe(`/t/flutter/bin${sep}/usr/bin`);
    expect(child['JAVA_HOME']).toBe('/t/jdk');
    expect(child['FLUTTER_SUPPRESS_ANALYTICS']).toBe('true');
  });
});

describe('cmd.exe argument safety', () => {
  it('quotes separators and rejects metacharacters', () => {
    expect(quoteCmdArg('--install')).toBe('--install');
    expect(quoteCmdArg('platforms;android-36')).toBe('"platforms;android-36"');
    expect(quoteCmdArg('--jdk-dir=C:\\dev\\jdk')).toBe('"--jdk-dir=C:\\dev\\jdk"');
    for (const bad of ['a&b', 'a|b', 'a>b', '%PATH%', 'a^b', 'x"y', 'a!b', 'line\nbreak']) {
      expect(() => quoteCmdArg(bad)).toThrow(/unsafe/);
    }
  });

  it('builds a /s /c command line', () => {
    expect(
      batchCommandLine('C:\\dev\\flutter\\bin\\flutter.bat', ['config', '--no-analytics']),
    ).toBe('"C:\\dev\\flutter\\bin\\flutter.bat config --no-analytics"');
  });
});

describe('install path rules', () => {
  it('rejects spaces, non-ASCII and shell metacharacters', () => {
    expect(pathProblem('C:\\dev\\toolchain')).toBeNull();
    expect(pathProblem('/home/asha/dev/toolchain')).toBeNull();
    expect(pathProblem('C:\\Users\\John Smith\\dev')).toMatch(/spaces/);
    expect(pathProblem('/home/josé/dev')).toMatch(/non-ASCII/);
    expect(pathProblem('C:\\Users\\a&b\\dev')).toMatch(/special/);
    expect(pathProblem('C:\\Users\\100%\\dev')).toMatch(/special/);
  });
});
