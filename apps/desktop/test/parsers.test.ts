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
