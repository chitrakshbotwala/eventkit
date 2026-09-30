import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DesiredEnv } from './env-overlay';
import { run } from './exec';

export const BLOCK_START = '# >>> eventkit toolchain >>> (managed by EventKit, do not edit)';
export const BLOCK_END = '# <<< eventkit toolchain <<<';

/** Escape a value for use inside double quotes in sh/bash/zsh. */
export function shDoubleQuote(v: string): string {
  return `"${v.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function renderPosixBlock(env: DesiredEnv): string {
  const lines = [BLOCK_START];
  for (const [k, v] of Object.entries(env.vars).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) throw new Error(`invalid env var name ${k}`);
    lines.push(`export ${k}=${shDoubleQuote(v)}`);
  }
  if (env.path.length > 0) {
    lines.push(`export PATH=${shDoubleQuote(env.path.join(':')).slice(0, -1)}:$PATH"`);
  }
  lines.push(BLOCK_END);
  return lines.join('\n');
}

/** fish: single-quoted strings only need ' and \ escaped. */
export function renderFishBlock(env: DesiredEnv): string {
  const q = (v: string) => `'${v.replace(/(['\\])/g, '\\$1')}'`;
  const lines = [BLOCK_START];
  for (const [k, v] of Object.entries(env.vars).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`set -gx ${k} ${q(v)}`);
  }
  for (const p of [...env.path].reverse()) lines.push(`fish_add_path --global --prepend ${q(p)}`);
  lines.push(BLOCK_END);
  return lines.join('\n');
}

/** Insert or replace the managed block, leaving everything else untouched (idempotent). */
export function upsertBlock(content: string, block: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start !== -1 && end > start) {
    return content.slice(0, start) + block + content.slice(end + BLOCK_END.length);
  }
  const sep =
    content === '' || content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${sep}${block}\n`;
}

export function removeBlock(content: string): string {
  const start = content.indexOf(BLOCK_START);
  const end = content.indexOf(BLOCK_END);
  if (start === -1 || end < start) return content;
  return (content.slice(0, start) + content.slice(end + BLOCK_END.length)).replace(
    /\n{3,}/g,
    '\n\n',
  );
}

/** Which rc files to manage on macOS/Linux. */
export function rcFiles(
  home: string,
  platform: 'macos' | 'linux',
): Array<{ file: string; create: boolean; kind: 'posix' | 'fish' }> {
  const files: Array<{ file: string; create: boolean; kind: 'posix' | 'fish' }> = [
    { file: join(home, '.profile'), create: true, kind: 'posix' },
    { file: join(home, '.bashrc'), create: platform === 'linux', kind: 'posix' },
    // macOS default shell is zsh; login bash on macOS reads .bash_profile instead of .profile.
    { file: join(home, '.zshrc'), create: platform === 'macos', kind: 'posix' },
    { file: join(home, '.bash_profile'), create: false, kind: 'posix' },
  ];
  if (existsSync(join(home, '.config', 'fish'))) {
    files.push({
      file: join(home, '.config', 'fish', 'conf.d', 'eventkit.fish'),
      create: true,
      kind: 'fish',
    });
  }
  return files;
}

export async function persistPosix(
  env: DesiredEnv,
  home: string,
  platform: 'macos' | 'linux',
): Promise<string[]> {
  const written: string[] = [];
  for (const { file, create, kind } of rcFiles(home, platform)) {
    const exists = existsSync(file);
    if (!exists && !create) continue;
    const before = exists ? await readFile(file, 'utf8') : '';
    const block = kind === 'fish' ? renderFishBlock(env) : renderPosixBlock(env);
    const after = upsertBlock(before, block);
    if (after !== before) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, after);
      written.push(file);
    }
  }
  return written;
}

/**
 * Windows: update HKCU\Environment directly. PATH is read raw (without expanding
 * %VARS%) and written back as REG_EXPAND_SZ, avoiding `setx` (which truncates at
 * 1024 chars and expands variables). Setting a user variable through .NET then
 * broadcasts WM_SETTINGCHANGE so new shells/Explorer pick up the change.
 * The script is constant; data arrives through an environment variable.
 */
export const WINDOWS_ENV_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$data = $env:EK_ENV_JSON | ConvertFrom-Json
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$parts = @($raw -split ';' | Where-Object { $_ -ne '' })
$norm = { param($p) $p.TrimEnd('\').ToLowerInvariant() }
$existing = @($parts | ForEach-Object { & $norm $_ })
$add = @()
foreach ($p in @($data.path)) {
  if ($existing -notcontains (& $norm $p)) { $add += $p }
}
$final = (@($add) + $parts) -join ';'
if ($final -ne $raw) { $key.SetValue('Path', $final, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
foreach ($prop in $data.vars.PSObject.Properties) {
  $key.SetValue($prop.Name, [string]$prop.Value, [Microsoft.Win32.RegistryValueKind]::String)
}
$key.Close()
[Environment]::SetEnvironmentVariable('EVENTKIT_ENV_TOUCH', '1', 'User')
[Environment]::SetEnvironmentVariable('EVENTKIT_ENV_TOUCH', $null, 'User')
Write-Output ('added ' + $add.Count + ' PATH entries')
`;

export function powershellExe(): string {
  return join(
    process.env['SystemRoot'] ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

export function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export async function persistWindows(env: DesiredEnv): Promise<string> {
  const res = await run(
    powershellExe(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodePowerShell(WINDOWS_ENV_SCRIPT),
    ],
    { env: { ...process.env, EK_ENV_JSON: JSON.stringify(env) }, timeoutMs: 60_000 },
  );
  return res.stdout.trim();
}
