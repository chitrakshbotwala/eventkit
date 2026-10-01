import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flutterArchiveKind, FlutterReleaseNotFoundError, selectFlutterRelease } from '../src';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'releases', name), 'utf8')) as unknown;

describe('selectFlutterRelease', () => {
  it('picks current stable for macOS arm64', () => {
    const r = selectFlutterRelease(fixture('releases_macos.json'), 'macos', 'arm64');
    expect(r.version).toBe('3.35.4');
    expect(r.arch).toBe('arm64');
    expect(r.sha256).toBe('3'.repeat(64));
    expect(r.url).toBe(
      'https://storage.googleapis.com/flutter_infra_release/releases/stable/macos/flutter_macos_arm64_3.35.4-stable.zip',
    );
    expect(r.fileName).toBe('flutter_macos_arm64_3.35.4-stable.zip');
    expect(r.dartVersion).toBe('3.9.2');
    expect(r.emulated).toBe(false);
  });

  it('picks the x64 build for macOS Intel', () => {
    const r = selectFlutterRelease(fixture('releases_macos.json'), 'macos', 'x64');
    expect(r.sha256).toBe('2'.repeat(64));
    expect(r.fileName).toBe('flutter_macos_3.35.4-stable.zip');
  });

  it('honours a pinned version', () => {
    const r = selectFlutterRelease(fixture('releases_macos.json'), 'macos', 'arm64', '3.35.3');
    expect(r.version).toBe('3.35.3');
    expect(r.sha256).toBe('4'.repeat(64));
  });

  it('never selects beta even when pinned to a beta version string', () => {
    expect(() =>
      selectFlutterRelease(fixture('releases_macos.json'), 'macos', 'arm64', '3.37.0-0.1.pre'),
    ).toThrow(FlutterReleaseNotFoundError);
  });

  it('treats entries without dart_sdk_arch as x64', () => {
    const r = selectFlutterRelease(fixture('releases_macos.json'), 'macos', 'x64', '2.10.5');
    expect(r.arch).toBe('x64');
    expect(() =>
      selectFlutterRelease(fixture('releases_macos.json'), 'macos', 'arm64', '2.10.5'),
    ).toThrow(/no Flutter/);
  });

  it('falls back to x64 on Windows arm64 (emulated)', () => {
    const r = selectFlutterRelease(fixture('releases_windows.json'), 'windows', 'arm64');
    expect(r.arch).toBe('x64');
    expect(r.emulated).toBe(true);
  });

  it('handles linux tar.xz archives', () => {
    const r = selectFlutterRelease(fixture('releases_linux.json'), 'linux', 'x64');
    expect(flutterArchiveKind(r.fileName)).toBe('tar.xz');
    expect(flutterArchiveKind('flutter_windows_3.35.4-stable.zip')).toBe('zip');
  });

  it('errors on unknown pinned version and malformed JSON', () => {
    expect(() =>
      selectFlutterRelease(fixture('releases_windows.json'), 'windows', 'x64', '9.9.9'),
    ).toThrow(/not found/);
    expect(() => selectFlutterRelease({ nope: true }, 'windows', 'x64')).toThrow();
  });
});
