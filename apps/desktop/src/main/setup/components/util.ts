import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExecError, RunOptions, RunResult } from '../exec';
import { which } from '../exec';
import { flutterBin } from '../paths';
import type { ComponentContext } from '../types';

/** Run a tool with the toolchain environment, streaming output to the log. */
export function sh(
  ctx: ComponentContext,
  file: string,
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const name = file.split(/[\\/]/).pop();
  ctx.log.info(`$ ${name} ${args.join(' ')}`);
  return ctx.exec.run(file, args, {
    env: ctx.env.childEnv(),
    signal: ctx.signal,
    timeoutMs: 10 * 60_000,
    onLine: (l) => ctx.log.debug(`  ${name}: ${l}`),
    ...opts,
  });
}

/** Run a tool, returning null instead of throwing (for detection). */
export async function tryRun(
  ctx: ComponentContext,
  file: string,
  args: string[],
  opts: RunOptions = {},
) {
  try {
    return await ctx.exec.run(file, args, {
      env: ctx.env.childEnv(),
      signal: ctx.signal,
      timeoutMs: 2 * 60_000,
      allowFailure: true,
      ...opts,
    });
  } catch {
    return null;
  }
}

export function flutter(ctx: ComponentContext, args: string[], opts: RunOptions = {}) {
  return sh(ctx, flutterBin(ctx.dirs, ctx.platform), args, opts);
}

export function hasFlutter(ctx: ComponentContext) {
  return existsSync(flutterBin(ctx.dirs, ctx.platform));
}

export function firstExisting(paths: Array<string | undefined | null>): string | null {
  for (const p of paths) if (p && existsSync(p)) return p;
  return null;
}

/** PATH lookup including directories we've added in this session. */
export function whichInToolchain(ctx: ComponentContext, name: string) {
  const env = ctx.env.childEnv();
  const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return which(name, env[pathKey] ?? '');
}

export const win = {
  localAppData: () => process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
  programFiles: () => process.env['ProgramFiles'] ?? 'C:\\Program Files',
  programFilesX86: () => process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
};

export function parseVersionFrom(text: string, re: RegExp): string | undefined {
  return re.exec(text)?.[1];
}

/** Extract the first JSON object from noisy tool output (banners, warnings). */
export function jsonFromOutput<T>(text: string): T | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export interface FlutterVersionInfo {
  frameworkVersion: string;
  channel: string;
  dartSdkVersion?: string;
  devToolsVersion?: string;
  flutterRoot?: string;
}

export async function flutterVersion(ctx: ComponentContext): Promise<FlutterVersionInfo | null> {
  if (!hasFlutter(ctx)) return null;
  const res = await tryRun(ctx, flutterBin(ctx.dirs, ctx.platform), ['--version', '--machine'], {
    timeoutMs: 5 * 60_000,
  });
  if (!res || res.code !== 0) return null;
  const info = jsonFromOutput<FlutterVersionInfo>(res.stdout);
  if (info?.frameworkVersion) {
    ctx.facts.flutterVersion = info.frameworkVersion;
    if (info.devToolsVersion) ctx.facts.devtoolsVersion = info.devToolsVersion;
  }
  return info;
}

/** Auto-answer "(y/N)" style prompts (license acceptance). */
export function yesResponder(ctx: ComponentContext) {
  return (chunk: string) =>
    /\(y\/N\)|\[y\/N\]|Accept\?/i.test(chunk) ? (ctx.log.debug('  answering y'), 'y\n') : null;
}

export function describeExecError(err: unknown): string {
  const e = err as ExecError;
  return e?.message ?? String(err);
}

/** Proxy like "PROXY host:port; DIRECT" (Electron resolveProxy) -> http://host:port */
export function proxyUrlFromPac(pac: string): string | null {
  const m = /(?:PROXY|HTTPS)\s+([^\s;]+)/i.exec(pac);
  return m ? `http://${m[1]}` : null;
}
