import { existsSync } from 'node:fs';
import type { Artifact, ComponentOf, ManifestPayload } from '@eventkit/shared';
import { findComponent } from '@eventkit/shared';
import { which } from '../exec';
import { SetupError, type ComponentContext, type ComponentRunner } from '../types';
import { COMPONENT_WEIGHTS } from './meta';
import { sh, tryRun } from './util';

type PM = 'apt' | 'dnf' | 'pacman' | 'zypper';

const PM_BINARIES: Array<[PM, string]> = [
  ['apt', '/usr/bin/apt-get'],
  ['dnf', '/usr/bin/dnf'],
  ['pacman', '/usr/bin/pacman'],
  ['zypper', '/usr/bin/zypper'],
];

/**
 * Constant scripts run as root via ONE pkexec prompt. Packages (and the local
 * Chrome package path) arrive as positional arguments ("$@"), never
 * interpolated into the script.
 */
export const PM_SCRIPTS: Record<PM, string> = {
  apt: 'set -e; export DEBIAN_FRONTEND=noninteractive; apt-get update || true; apt-get install -y "$@"',
  dnf: 'set -e; dnf install -y "$@"',
  pacman: 'set -e; pacman -Sy --needed --noconfirm "$@"',
  zypper:
    'set -e; rpm --import https://dl.google.com/linux/linux_signing_key.pub || true; zypper --non-interactive install --allow-unsigned-rpm "$@"',
};

export function detectPackageManager(): PM | null {
  for (const [pm, bin] of PM_BINARIES) if (existsSync(bin)) return pm;
  return null;
}

const CHROME_BINARIES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
];
const CHROMIUM_BINARIES = ['/usr/bin/chromium', '/usr/bin/chromium-browser'];

export function linuxChromePath(): string | null {
  for (const p of [...CHROME_BINARIES, ...CHROMIUM_BINARIES]) if (existsSync(p)) return p;
  return null;
}

function chromeWanted(m: ManifestPayload) {
  return Boolean(findComponent(m, 'chrome')?.enabled) && !linuxChromePath();
}

function chromeArtifact(m: ManifestPayload, pm: PM | null): Artifact | null {
  const chrome = findComponent(m, 'chrome');
  if (!chrome?.linuxPackages || !pm) return null;
  if (pm === 'apt') return chrome.linuxPackages.deb;
  if (pm === 'dnf' || pm === 'zypper') return chrome.linuxPackages.rpm;
  return null; // pacman: chromium from the repos instead
}

/** Which of `pkgs` are not installed. */
export async function missingPackages(
  ctx: ComponentContext,
  pm: PM,
  pkgs: string[],
): Promise<string[]> {
  if (pkgs.length === 0) return [];
  if (pm === 'apt') {
    const res = await tryRun(ctx, '/usr/bin/dpkg-query', [
      '-W',
      '-f=${Package} ${Status}\n',
      ...pkgs,
    ]);
    const ok = new Set(
      (res?.stdout ?? '')
        .split('\n')
        .filter((l) => l.includes('install ok installed'))
        .map((l) => l.split(' ')[0]!.split(':')[0]!),
    );
    return pkgs.filter((p) => !ok.has(p));
  }
  if (pm === 'pacman') {
    const res = await tryRun(ctx, '/usr/bin/pacman', ['-Q', ...pkgs]);
    const ok = new Set((res?.stdout ?? '').split('\n').map((l) => l.split(' ')[0]));
    return pkgs.filter((p) => !ok.has(p));
  }
  // rpm: one query per package so multi-provider output cannot misalign results.
  const missing: string[] = [];
  for (const p of pkgs) {
    const res = await tryRun(ctx, '/usr/bin/rpm', ['-q', '--whatprovides', p]);
    if (res?.code !== 0) missing.push(p);
  }
  return missing;
}

function wantedPackages(c: ComponentOf<'linux-deps'>, m: ManifestPayload, pm: PM): string[] {
  const pkgs = [...c.packages[pm]];
  if (pm === 'pacman' && chromeWanted(m)) pkgs.push('chromium');
  return pkgs;
}

export const linuxDepsRunner: ComponentRunner<ComponentOf<'linux-deps'>> = {
  id: 'linux-deps',
  weight: COMPONENT_WEIGHTS['linux-deps'],
  dependsOn: () => ['system'],
  artifacts(_c, ctx) {
    const a = chromeWanted(ctx.manifest)
      ? chromeArtifact(ctx.manifest, detectPackageManager())
      : null;
    return a ? [a] : [];
  },
  async detect(c, ctx) {
    const pm = detectPackageManager();
    if (!pm)
      return {
        installed: false,
        detail: 'no supported package manager (apt, dnf, pacman, zypper)',
      };
    ctx.facts.packageManager = pm;
    const missing = await missingPackages(ctx, pm, wantedPackages(c, ctx.manifest, pm));
    const needChrome = chromeWanted(ctx.manifest);
    return { installed: missing.length === 0 && !needChrome, detail: missing.join(' ') };
  },
  async install(c, ctx) {
    const pm = detectPackageManager();
    if (!pm) {
      throw new SetupError(
        'Unsupported Linux distribution: no apt, dnf, pacman or zypper found.',
        `Install manually: ${c.packages.apt.join(' ')}`,
      );
    }
    const args = await missingPackages(ctx, pm, wantedPackages(c, ctx.manifest, pm));
    const chromePkg = chromeWanted(ctx.manifest) ? chromeArtifact(ctx.manifest, pm) : null;
    if (chromePkg) {
      ctx.step('download', 'Downloading Google Chrome package');
      args.push(await ctx.download(chromePkg));
      ctx.step('verify-hash', 'Chrome package verified');
    }
    if (args.length === 0) return;

    const pkexec = await which('pkexec');
    const manual = `sudo ${pm === 'apt' ? 'apt-get install -y' : pm === 'dnf' ? 'dnf install -y' : pm === 'pacman' ? 'pacman -S --needed' : 'zypper install'} ${args.join(' ')}`;
    if (!pkexec)
      throw new SetupError(
        'pkexec (polkit) is not available to request administrator rights.',
        `Run this in a terminal, then press Retry: ${manual}`,
      );

    await ctx.elevate(
      `Installing ${args.length} system package(s) (git, build tools${chromePkg ? ', Google Chrome' : ''}) needs administrator rights. Enter your password in the system dialog.`,
    );
    ctx.step('install', `Installing system packages with ${pm}`);
    try {
      await sh(ctx, pkexec, ['/bin/sh', '-c', PM_SCRIPTS[pm], 'eventkit', ...args], {
        timeoutMs: 45 * 60_000,
        onLine: (l) => {
          ctx.log.debug(`  ${pm}: ${l}`);
          if (/^(Setting up|Installing|Unpacking|\(\d+\/\d+\))/.test(l))
            ctx.progress({ message: l.slice(0, 120) });
        },
      });
    } catch (err) {
      const code = (err as { result?: { code?: number } }).result?.code;
      if (code === 126 || code === 127) {
        throw new SetupError(
          'Administrator permission was not granted.',
          `Press Retry and approve the dialog, or run: ${manual}`,
        );
      }
      throw err;
    }
  },
  async verify(c, ctx) {
    const pm = detectPackageManager();
    if (!pm) return { ok: false, detail: 'no supported package manager' };
    if (ctx.quick) return { ok: Boolean(await which('git')), detail: 'git not found' };
    const missing = await missingPackages(ctx, pm, wantedPackages(c, ctx.manifest, pm));
    if (missing.length) return { ok: false, detail: `missing packages: ${missing.join(' ')}` };
    if (chromeWanted(ctx.manifest)) return { ok: false, detail: 'Google Chrome not installed' };
    return { ok: true, version: pm };
  },
};
