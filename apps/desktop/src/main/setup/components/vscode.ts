import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ComponentOf } from '@eventkit/shared';
import { which } from '../exec';
import { extractArchive, replaceDir, singleChild } from '../extract';
import { writable } from '../paths';
import { SetupError, type ComponentContext, type ComponentRunner } from '../types';
import { COMPONENT_WEIGHTS } from './meta';
import { firstExisting, sh, tryRun, win } from './util';
import { wingetInstall } from './winget';

const MAC_APP = 'Visual Studio Code.app';
const MAC_CLI = join('Contents', 'Resources', 'app', 'bin', 'code');

async function findCli(ctx: ComponentContext): Promise<string | null> {
  if (ctx.platform === 'windows') {
    return firstExisting([
      join(win.localAppData(), 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
      join(win.programFiles(), 'Microsoft VS Code', 'bin', 'code.cmd'),
    ]);
  }
  if (ctx.platform === 'macos') {
    return firstExisting([
      join('/Applications', MAC_APP, MAC_CLI),
      join(homedir(), 'Applications', MAC_APP, MAC_CLI),
    ]);
  }
  return (
    firstExisting([
      join(ctx.dirs.vscode, 'bin', 'code'),
      '/usr/share/code/bin/code',
      '/snap/bin/code',
    ]) ?? (await which('code'))
  );
}

async function version(ctx: ComponentContext, cli: string) {
  const res = await tryRun(ctx, cli, ['--version'], { timeoutMs: 60_000 });
  return res?.code === 0 ? res.stdout.split(/\r?\n/)[0]?.trim() : undefined;
}

async function listExtensions(ctx: ComponentContext, cli: string): Promise<Set<string>> {
  const res = await tryRun(ctx, cli, ['--list-extensions'], { timeoutMs: 60_000 });
  return new Set(
    (res?.stdout ?? '')
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

function configure(ctx: ComponentContext, cli: string) {
  ctx.facts.vscodeCli = cli;
  ctx.env.addPath(join(cli, '..'));
}

async function installApp(c: ComponentOf<'vscode'>, ctx: ComponentContext) {
  if (ctx.platform === 'windows' && !ctx.manifest.mirrorBaseUrl && c.wingetId) {
    ctx.step('install', 'Installing VS Code with winget (current user)');
    if (await wingetInstall(ctx, c.wingetId)) return;
  }
  if (!c.artifact) throw new SetupError('No VS Code download in the manifest');
  ctx.step('download', 'Downloading VS Code');
  const file = await ctx.download(c.artifact);
  if (ctx.platform === 'windows') {
    ctx.step('install', 'Running the VS Code user installer (silent)');
    await sh(ctx, file, c.artifact.installArgs, { timeoutMs: 15 * 60_000 });
    return;
  }
  ctx.step('install', 'Extracting VS Code');
  const staging = join(ctx.dirs.staging, 'vscode');
  await extractArchive(file, staging, c.artifact.kind, ctx.platform, { signal: ctx.signal });
  if (ctx.platform === 'macos') {
    const target = writable('/Applications') ? '/Applications' : join(homedir(), 'Applications');
    await mkdir(target, { recursive: true });
    await replaceDir(join(staging, MAC_APP), join(target, MAC_APP));
    return;
  }
  // Linux tarball (no root): <root>/vscode plus a desktop entry.
  await replaceDir(await singleChild(staging), ctx.dirs.vscode);
  const apps = join(homedir(), '.local', 'share', 'applications');
  await mkdir(apps, { recursive: true });
  await writeFile(
    join(apps, 'eventkit-vscode.desktop'),
    [
      '[Desktop Entry]',
      'Name=Visual Studio Code',
      'Comment=Code Editing. Redefined.',
      `Exec=${join(ctx.dirs.vscode, 'code')} %F`,
      `Icon=${join(ctx.dirs.vscode, 'resources', 'app', 'resources', 'linux', 'code.png')}`,
      'Type=Application',
      'Categories=Development;IDE;',
      '',
    ].join('\n'),
  );
}

export const vscodeRunner: ComponentRunner<ComponentOf<'vscode'>> = {
  id: 'vscode',
  weight: COMPONENT_WEIGHTS.vscode,
  dependsOn: () => ['system'],
  artifacts: (c, ctx) =>
    c.artifact && (ctx.platform !== 'windows' || ctx.manifest.mirrorBaseUrl || !c.wingetId)
      ? [c.artifact]
      : [],
  async detect(_c, ctx) {
    const cli = await findCli(ctx);
    if (!cli) return { installed: false };
    return { installed: true, path: cli, version: await version(ctx, cli) };
  },
  async install(c, ctx) {
    let cli = await findCli(ctx);
    if (!cli) {
      await installApp(c, ctx);
      cli = await findCli(ctx);
      if (!cli)
        throw new SetupError('VS Code was installed but its command-line launcher was not found');
    }
    configure(ctx, cli);
    ctx.step('configure', 'Installing Dart and Flutter extensions');
    const have = await listExtensions(ctx, cli);
    for (const [i, ext] of c.extensions.entries()) {
      if (have.has(ext.toLowerCase())) continue;
      ctx.progress({ percent: 75 + i * 10, message: `Installing extension ${ext}` });
      await sh(ctx, cli, ['--install-extension', ext, '--force'], { timeoutMs: 10 * 60_000 });
    }
  },
  async verify(c, ctx) {
    const cli = await findCli(ctx);
    if (!cli || !existsSync(cli)) return { ok: false, detail: 'VS Code not found' };
    configure(ctx, cli);
    const v = await version(ctx, cli);
    if (!v) return { ok: false, detail: 'code --version failed' };
    const have = await listExtensions(ctx, cli);
    const missing = c.extensions.filter((e) => !have.has(e.toLowerCase()));
    if (missing.length)
      return { ok: false, version: v, detail: `missing extensions: ${missing.join(', ')}` };
    return { ok: true, version: v };
  },
};
