import { describe, expect, it } from 'vitest';
import { parseInstalled } from '../src/main/setup/components/android';
import { PM_SCRIPTS } from '../src/main/setup/components/linux-deps';
import { jsonFromOutput, proxyUrlFromPac } from '../src/main/setup/components/util';
import { redact } from '../src/main/logger';

describe('sdkmanager --list_installed parsing', () => {
  it('extracts package paths', () => {
    const out = `Installed packages:
  Path                 | Version | Description                    | Location
  -------              | ------- | -------                        | -------
  build-tools;36.0.0   | 36.0.0  | Android SDK Build-Tools 36     | build-tools\\36.0.0
  platform-tools       | 36.0.0  | Android SDK Platform-Tools     | platform-tools
  platforms;android-36 | 2       | Android SDK Platform 36        | platforms\\android-36
`;
    expect([...parseInstalled(out)].sort()).toEqual([
      'build-tools;36.0.0',
      'platform-tools',
      'platforms;android-36',
    ]);
  });

  it('reads the format of cmdline-tools 23+, which hands off to the android CLI', () => {
    const out = `WARNING: The SDK Manager CLI tool (sdkmanager) is deprecated. Android CLI will be used instead.
The 'android' binary can also be found in the cmdline-tools directory, and 'android sdk' is the replacement for 'sdkmanager'.
To learn more about the Android CLI and how to use it, see the documentation (https://d.android.com/tools/agents/android-cli)
Installed packages:
  build-tools/36.0.0                                              36.0.0                             Android SDK Build-Tools 36
  cmdline-tools/latest                                            unknown         ->        23.0.0   Android SDK Command-line Tools (latest)
  emulator                                                        36.3.10         ->        37.2.12  Android Emulator
  platform-tools                                                  37.0.1                             Android SDK Platform-Tools
  platforms/android-36                                            2.0.0                              Android SDK Platform 36
  system-images/android-36.1/google_apis_playstore/x86_64         4.0.0                              Google Play Intel x86_64 Atom System Image
`;
    expect([...parseInstalled(out)].sort()).toEqual([
      'build-tools;36.0.0',
      'cmdline-tools;latest',
      'emulator',
      'platform-tools',
      'platforms;android-36',
      'system-images;android-36.1;google_apis_playstore;x86_64',
    ]);
  });

  it('reads the coloured output the android CLI writes to a pipe', () => {
    const out =
      'Installed packages:\r\n' +
      '\u001b[32m  build-tools/36.0.0        36.0.0      Android SDK Build-Tools 36   \u001b[39m\u001b[0m\r\n' +
      '\u001b[32m  platform-tools            37.0.1      Android SDK Platform-Tools   \u001b[39m\u001b[0m\r\n' +
      '\u001b[32m  platforms/android-36      2.0.0       Android SDK Platform 36      \u001b[39m\u001b[0m\r\n';
    expect([...parseInstalled(out)].sort()).toEqual([
      'build-tools;36.0.0',
      'platform-tools',
      'platforms;android-36',
    ]);
  });

  it('ignores packages listed under other sections', () => {
    const out = `Installed packages:
  platform-tools       | 36.0.0  | Android SDK Platform-Tools     | platform-tools

Available Updates:
  platforms;android-37 | 1       | Android SDK Platform 37
`;
    expect([...parseInstalled(out)]).toEqual(['platform-tools']);
  });
});

describe('flutter --version --machine', () => {
  it('finds JSON after a first-run banner', () => {
    const out = `
  ╔════════════════════════════════════════════════════════════════════════════╗
  ║                 Welcome to Flutter! - https://flutter.dev                  ║
  ╚════════════════════════════════════════════════════════════════════════════╝
{
  "frameworkVersion": "3.35.4",
  "channel": "stable",
  "devToolsVersion": "2.48.0"
}`;
    expect(jsonFromOutput<{ frameworkVersion: string }>(out)?.frameworkVersion).toBe('3.35.4');
    expect(jsonFromOutput('no json here')).toBeNull();
  });
});

describe('proxy detection', () => {
  it('converts PAC results', () => {
    expect(proxyUrlFromPac('DIRECT')).toBeNull();
    expect(proxyUrlFromPac('PROXY proxy.corp:3128; DIRECT')).toBe('http://proxy.corp:3128');
  });
});

describe('pkexec scripts', () => {
  it('take packages only as positional arguments', () => {
    for (const s of Object.values(PM_SCRIPTS)) {
      expect(s).toContain('"$@"');
      expect(s).not.toMatch(/\$\{|`/);
    }
  });
});

describe('log redaction', () => {
  it('removes tokens, keys and QR payloads', () => {
    expect(redact('authorization: Bearer abc.def-123')).not.toContain('abc.def');
    expect(redact('{"token":"s3cr3t","ok":1}')).not.toContain('s3cr3t');
    expect(redact('deviceKey=AAAA==')).not.toContain('AAAA');
    expect(redact('payload EK1.cmabc.29000000.12345678 scanned')).toBe(
      'payload EK1.[redacted] scanned',
    );
  });
});
