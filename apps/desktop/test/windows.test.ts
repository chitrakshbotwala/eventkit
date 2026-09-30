import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodePowerShell, powershellExe, WINDOWS_ENV_SCRIPT } from '../src/main/setup/env-persist';
import { run } from '../src/main/setup/exec';
import { extractArchive } from '../src/main/setup/extract';

// These run real Windows tools, but only against temp files (no system changes).
const onWindows = process.platform === 'win32';

describe.runIf(onWindows)('Windows integration (safe, temp-only)', () => {
  it('passes batch arguments through cmd.exe as single tokens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ek-bat-'));
    const bat = join(dir, 'echoargs.bat');
    writeFileSync(bat, '@echo off\r\necho [%~1][%~2][%~3][%~4]\r\n');
    const res = await run(bat, [
      'platforms;android-36',
      '--sdk_root=C:\\dev\\toolchain\\android-sdk',
      'build-tools;36.0.0',
      '--x',
    ]);
    expect(res.stdout.trim()).toBe(
      '[platforms;android-36][--sdk_root=C:\\dev\\toolchain\\android-sdk][build-tools;36.0.0][--x]',
    );
  });

  it('refuses metacharacters before cmd.exe ever runs', async () => {
    await expect(run('C:\\nope\\x.bat', ['a & calc'])).rejects.toThrow(/unsafe/);
  });

  it('the PATH/registry PowerShell script parses without errors', async () => {
    const check = `
$errors = $null
$null = [System.Management.Automation.Language.Parser]::ParseInput($env:EK_SCRIPT, [ref]$null, [ref]$errors)
Write-Output $errors.Count`;
    const res = await run(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(check)],
      {
        env: { ...process.env, EK_SCRIPT: WINDOWS_ENV_SCRIPT },
      },
    );
    expect(res.stdout.trim()).toBe('0');
  });

  it('extracts zips with the built-in tar.exe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ek-zip-'));
    const src = join(dir, 'src', 'flutter', 'bin');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'flutter.bat'), 'echo hi');
    const zip = join(dir, 'a.zip');
    const ps = `Compress-Archive -Path $env:EK_SRC -DestinationPath $env:EK_ZIP`;
    await run(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(ps)],
      {
        env: { ...process.env, EK_SRC: join(dir, 'src', 'flutter'), EK_ZIP: zip },
      },
    );
    const out = join(dir, 'out');
    await extractArchive(zip, out, 'zip', 'windows');
    expect(existsSync(join(out, 'flutter', 'bin', 'flutter.bat'))).toBe(true);
    expect(readFileSync(join(out, 'flutter', 'bin', 'flutter.bat'), 'utf8')).toBe('echo hi');
  }, 60_000);
});
