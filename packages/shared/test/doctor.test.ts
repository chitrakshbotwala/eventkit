import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateDoctor, parseFlutterDoctor } from '../src';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', 'doctor', name), 'utf8');

const opts = { androidRequired: true, vscodeVerifiedLocally: true };

describe('parseFlutterDoctor', () => {
  it('parses a passing Windows run with unicode markers and timings', () => {
    const s = parseFlutterDoctor(fixture('windows-pass.txt'));
    expect(s.flutterVersion).toBe('3.35.4');
    expect(s.channel).toBe('stable');
    expect(s.dartVersion).toBe('3.9.2');
    const keys = s.categories.map((c) => `${c.key}:${c.status}`);
    expect(keys).toEqual([
      'flutter:ok',
      'windows:ok',
      'android:ok',
      'chrome:ok',
      'visual-studio:missing',
      'android-studio:partial',
      'vscode:ok',
      'devices:ok',
      'network:ok',
    ]);
    const vs = s.categories.find((c) => c.key === 'visual-studio')!;
    expect(vs.errors[0]).toMatch(/^Visual Studio not installed.*Desktop development with C\+\+/);
    expect(s.categories[0]!.title).not.toMatch(/ms\]$/);
  });

  it('parses ASCII fallback markers and CRLF', () => {
    const s = parseFlutterDoctor(fixture('windows-ascii-fail.txt'));
    expect(s.flutterVersion).toBe('3.35.4');
    const android = s.categories.find((c) => c.key === 'android')!;
    expect(android.status).toBe('missing');
    expect(android.errors).toHaveLength(2);
    expect(android.errors[0]).toContain('cmdline-tools component is missing');
    expect(android.errors[0]).toContain('Alternatively, download the tools');
    expect(s.categories.find((c) => c.key === 'chrome')!.status).toBe('missing');
  });

  it('strips ANSI color codes', () => {
    const s = parseFlutterDoctor('\u001b[32m[✓]\u001b[39m Chrome - develop for the web\n');
    expect(s.categories[0]).toMatchObject({ key: 'chrome', status: 'ok' });
  });

  it('parses the Linux offline run', () => {
    const s = parseFlutterDoctor(fixture('linux-offline-pass.txt'));
    const net = s.categories.find((c) => c.key === 'network')!;
    expect(net.status).toBe('partial');
    expect(net.errors).toHaveLength(4);
    expect(s.categories.find((c) => c.key === 'linux-toolchain')!.status).toBe('ok');
  });
});

describe('evaluateDoctor', () => {
  it('passes on Windows despite missing Visual Studio / Android Studio', () => {
    const r = evaluateDoctor(parseFlutterDoctor(fixture('windows-pass.txt')), opts);
    expect(r.passed).toBe(true);
    expect(r.warnings.some((w) => w.startsWith('Visual Studio'))).toBe(true);
    expect(r.warnings.some((w) => w.startsWith('Android Studio'))).toBe(true);
  });

  it('never blocks on network resources or devices (offline)', () => {
    const r = evaluateDoctor(parseFlutterDoctor(fixture('linux-offline-pass.txt')), opts);
    expect(r.passed).toBe(true);
    expect(r.warnings.some((w) => w.startsWith('Network resources'))).toBe(true);
    expect(r.warnings.some((w) => w.startsWith('Connected device'))).toBe(true);
  });

  it('fails when Android toolchain and Chrome are broken', () => {
    const r = evaluateDoctor(parseFlutterDoctor(fixture('windows-ascii-fail.txt')), opts);
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.includes('cmdline-tools'))).toBe(true);
    expect(r.failures.some((f) => f.startsWith('Chrome'))).toBe(true);
  });

  it('ignores Android toolchain when the component is disabled', () => {
    const r = evaluateDoctor(parseFlutterDoctor(fixture('windows-ascii-fail.txt')), {
      ...opts,
      androidRequired: false,
    });
    expect(r.failures.some((f) => f.includes('cmdline-tools'))).toBe(false);
    expect(r.failures.some((f) => f.startsWith('Chrome'))).toBe(true);
  });

  it('fails on unaccepted Android licenses, but not on Xcode', () => {
    const r = evaluateDoctor(parseFlutterDoctor(fixture('macos-licenses-fail.txt')), opts);
    expect(r.passed).toBe(false);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatch(/licenses not accepted/);
    expect(r.warnings.some((w) => w.startsWith('Xcode'))).toBe(true);
    // VS Code partial (extension warning) is a warning, not a failure.
    expect(r.warnings.some((w) => w.startsWith('VS Code'))).toBe(true);
  });

  it('accepts "license status unknown" (Flutter < 3.47 with cmdline-tools 23+) only when licenses are verified locally', () => {
    const summary =
      parseFlutterDoctor(`[✓] Flutter (Channel stable, 3.44.6, on Microsoft Windows [Version 10.0.26200], locale en-IN)
[!] Android toolchain - develop for Android devices (Android SDK version 36.1.0)
    • Android SDK at C:\\Users\\dev\\AppData\\Local\\Android\\Sdk
    X Android license status unknown.
      Run \`flutter doctor --android-licenses\` to accept the SDK licenses.
      See https://flutter.dev/to/windows-android-setup for more details.
[✓] Chrome - develop for the web
[✓] VS Code (version 1.140.0)
`);
    expect(evaluateDoctor(summary, opts).passed).toBe(false);
    const r = evaluateDoctor(summary, { ...opts, androidLicensesVerifiedLocally: true });
    expect(r.passed).toBe(true);
    expect(r.warnings.some((w) => w.includes('license status unknown'))).toBe(true);
    // Unaccepted licenses still fail, even with the local check.
    const notAccepted = parseFlutterDoctor(fixture('macos-licenses-fail.txt'));
    expect(
      evaluateDoctor(notAccepted, { ...opts, androidLicensesVerifiedLocally: true }).passed,
    ).toBe(false);
  });

  it('requires VS Code: uses local verification when doctor omits it', () => {
    const summary = parseFlutterDoctor(fixture('no-vscode.txt'));
    expect(evaluateDoctor(summary, opts).passed).toBe(true);
    const r = evaluateDoctor(summary, { ...opts, vscodeVerifiedLocally: false });
    expect(r.passed).toBe(false);
    expect(r.failures).toContain('VS Code: not installed');
  });

  it('fails when flutter itself is not reported', () => {
    const r = evaluateDoctor(parseFlutterDoctor(''), opts);
    expect(r.passed).toBe(false);
  });
});
