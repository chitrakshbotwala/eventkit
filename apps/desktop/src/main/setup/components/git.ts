import { join } from 'node:path';
import { satisfiesMin, type ComponentOf } from '@eventkit/shared';
import { which } from '../exec';
import { SetupError, type ComponentContext, type ComponentRunner } from '../types';
import { COMPONENT_WEIGHTS } from './meta';
import { firstExisting, sh, tryRun, win, whichInToolchain } from './util';
import { wingetInstall } from './winget';

async function findGit(ctx: ComponentContext): Promise<string | null> {
  if (ctx.platform === 'windows') {
    return (
      firstExisting([
        ctx.facts.gitExe,
        join(win.localAppData(), 'Programs', 'Git', 'cmd', 'git.exe'),
        join(win.programFiles(), 'Git', 'cmd', 'git.exe'),
        join(win.programFilesX86(), 'Git', 'cmd', 'git.exe'),
      ]) ?? (await whichInToolchain(ctx, 'git'))
    );
  }
  if (ctx.platform === 'macos') {
    // /usr/bin/git is a stub that pops up an installer when the Command Line Tools are missing.
    const brew = firstExisting(['/opt/homebrew/bin/git', '/usr/local/bin/git']);
    if (brew) return brew;
    const clt = await tryRun(ctx, '/usr/bin/xcode-select', ['-p']);
    return clt?.code === 0 ? '/usr/bin/git' : null;
  }
  return which('git');
}

async function gitVersion(ctx: ComponentContext, git: string) {
  const res = await tryRun(ctx, git, ['--version']);
  return res?.code === 0 ? /git version (\d+\.\d+\.\d+)/.exec(res.stdout)?.[1] : undefined;
}

async function waitForCommandLineTools(ctx: ComponentContext) {
  const started = Date.now();
  while (Date.now() - started < 60 * 60_000) {
    if (ctx.signal.aborted) throw new Error('cancelled');
    const res = await tryRun(ctx, '/usr/bin/xcode-select', ['-p']);
    if (res?.code === 0) return;
    const mins = Math.floor((Date.now() - started) / 60_000);
    ctx.progress({
      message: `Waiting for the Command Line Tools installer to finish (${mins} min)…`,
      percent: Math.min(90, 10 + mins * 5),
    });
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new SetupError(
    'The Command Line Tools installation did not finish within an hour.',
    'Finish it from the macOS dialog, then press Retry.',
  );
}

export const gitRunner: ComponentRunner<ComponentOf<'git'>> = {
  id: 'git',
  weight: COMPONENT_WEIGHTS.git,
  dependsOn: () => ['system', 'linux-deps'],
  artifacts: (c, ctx) =>
    ctx.platform === 'windows' && c.artifact && (ctx.manifest.mirrorBaseUrl || !c.wingetId)
      ? [c.artifact]
      : [],
  async detect(_c, ctx) {
    const git = await findGit(ctx);
    if (!git) return { installed: false };
    ctx.facts.gitExe = git;
    return { installed: true, path: git, version: await gitVersion(ctx, git) };
  },
  async install(c, ctx) {
    if (ctx.platform === 'macos') {
      await ctx.elevate(
        'macOS will ask to install the Command Line Tools (this provides git). Click "Install" in the dialog and accept the license.',
      );
      ctx.step('install', 'Installing Command Line Tools');
      await tryRun(ctx, '/usr/bin/xcode-select', ['--install']);
      await waitForCommandLineTools(ctx);
      return;
    }
    if (ctx.platform === 'linux') {
      throw new SetupError(
        'git is still missing after installing system packages.',
        'Install git with your package manager, then press Retry.',
      );
    }
    // Windows: winget (user scope) when no LAN mirror is configured, else/fallback the verified installer.
    let done = false;
    if (!ctx.manifest.mirrorBaseUrl && c.wingetId) {
      ctx.step('install', 'Installing with winget');
      done = await wingetInstall(ctx, c.wingetId);
    }
    if (!done) {
      if (!c.artifact) throw new SetupError('No Git installer in the manifest');
      ctx.step('download', 'Downloading Git for Windows');
      const installer = await ctx.download(c.artifact);
      ctx.step('install', 'Running Git installer (current user, silent)');
      await sh(ctx, installer, c.artifact.installArgs, { timeoutMs: 20 * 60_000 });
    }
    ctx.step('configure');
    const git = await findGit(ctx);
    if (!git) throw new SetupError('Git installer finished but git.exe was not found');
    ctx.facts.gitExe = git;
    ctx.env.addPath(join(git, '..'));
  },
  async verify(c, ctx) {
    const git = await findGit(ctx);
    if (!git) return { ok: false, detail: 'git not found' };
    ctx.facts.gitExe = git;
    if (ctx.platform === 'windows') ctx.env.addPath(join(git, '..'));
    const version = await gitVersion(ctx, git);
    if (!satisfiesMin(version, c.minVersion))
      return { ok: false, version, detail: `git ${version ?? '?'} < ${c.minVersion}` };
    return { ok: true, version };
  },
};
