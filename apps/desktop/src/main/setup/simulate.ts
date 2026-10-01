import {
  COMPONENT_IDS,
  type Artifact,
  type ComponentId,
  type ManifestComponent,
  parseFlutterDoctor,
  evaluateDoctor,
} from '@eventkit/shared';
import { join } from 'node:path';
import type { DownloaderLike } from './engine';
import type { DownloadProgress, DownloadRequest } from './downloader';
import { COMPONENT_WEIGHTS, dependsOnFor } from './components/meta';
import type { AnyRunner, ComponentContext } from './types';

/**
 * --simulate: every component pretends to download/install/verify with
 * realistic timing, so the UI, state machine, resume and retry paths can be
 * exercised on a dev machine without touching the system.
 */
export interface SimulateOptions {
  speed: number;
  /** "component:step" pairs that fail on the first attempt, e.g. "flutter:download". */
  failures: string[];
  /** Downloads drop once at ~40% and must resume. */
  flaky: boolean;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('cancelled'));
    });
  });

const failedOnce = new Set<string>();
function maybeFail(opts: SimulateOptions, id: ComponentId, step: string) {
  const key = `${id}:${step}`;
  if (opts.failures.includes(key) && !failedOnce.has(key)) {
    failedOnce.add(key);
    throw new Error(`Simulated failure in ${key} (press Retry)`);
  }
}

/** Fake downloader: advances bytes over time, supports flaky resume. */
export function simulatedDownloader(opts: SimulateOptions): DownloaderLike {
  const progressByDest = new Map<string, number>();
  const dropped = new Set<string>();
  return {
    async download(
      req: DownloadRequest,
      onProgress?: (p: DownloadProgress) => void,
      signal?: AbortSignal,
    ) {
      const total = Math.max(req.size ?? 0, 30e6);
      const bps = 80e6 * opts.speed;
      let done = progressByDest.get(req.dest) ?? 0;
      while (done < total) {
        await sleep(200, signal);
        done = Math.min(total, done + bps / 5);
        progressByDest.set(req.dest, done);
        onProgress?.({
          bytesDone: done,
          bytesTotal: total,
          speedBps: bps,
          etaSeconds: (total - done) / bps,
          url: req.urls[0]!,
          attempt: 1,
        });
        if (opts.flaky && !dropped.has(req.dest) && done / total > 0.4) {
          dropped.add(req.dest);
          await sleep(1500 / opts.speed, signal); // simulated network drop, then resume from the same offset
        }
      }
      const comp = req.label.split('-')[0] as ComponentId;
      maybeFail(opts, comp, 'download');
      return req.dest;
    },
  };
}

const SIM_DOCTOR = (
  flutter: string,
) => `[✓] Flutter (Channel stable, ${flutter}, on Simulated OS, locale en-US)
    • Flutter version ${flutter} on channel stable at /simulated/flutter
    • Dart version 3.9.2
[✓] Android toolchain - develop for Android devices (Android SDK version 36.0.0)
    • All Android licenses accepted.
[✓] Chrome - develop for the web
[✗] Visual Studio - develop Windows apps
    ✗ Visual Studio not installed; this is necessary to develop Windows apps.
[!] Android Studio (not installed)
[✓] VS Code (version 1.104.2)
[✓] Connected device (2 available)
[✓] Network resources
`;

function versionOf(c: ManifestComponent): string | undefined {
  switch (c.id) {
    case 'flutter':
      return c.version;
    case 'git':
      return c.version ?? '2.51.0';
    case 'java':
      return c.version ?? '17.0.16+8';
    case 'vscode':
      return c.version ?? '1.104.2';
    case 'android':
      return (
        c.packages
          .find((p) => p.startsWith('platforms;'))
          ?.split('-')
          .pop() ?? '36'
      );
    case 'chrome':
      return '140.0.7339.208';
    case 'devtools':
      return '2.48.0';
    default:
      return undefined;
  }
}

function simArtifacts(c: ManifestComponent): Artifact[] {
  const withLabel = (a: Artifact): Artifact => ({ ...a, fileName: `${c.id}-${a.fileName}` });
  if (c.id === 'android') return [withLabel(c.cmdlineTools)];
  if ('artifact' in c && c.artifact) return [withLabel(c.artifact)];
  return [];
}

export function simulatedRunners(opts: SimulateOptions): Partial<Record<ComponentId, AnyRunner>> {
  const runners: Partial<Record<ComponentId, AnyRunner>> = {};
  for (const id of COMPONENT_IDS) {
    runners[id] = {
      id,
      weight: COMPONENT_WEIGHTS[id],
      dependsOn: (c, m) => dependsOnFor(c, m),
      artifacts: (c) => simArtifacts(c),
      async detect(c, ctx) {
        const v = ctx.facts.simulated?.[c.id];
        return v !== undefined
          ? { installed: true, version: v || undefined }
          : { installed: false };
      },
      async install(c, ctx: ComponentContext) {
        for (const a of simArtifacts(c)) {
          ctx.step('download', `Downloading ${a.fileName.replace(`${c.id}-`, '')}`);
          await ctx.download(a);
          ctx.step('verify-hash', 'Verifying SHA-256');
          await sleep(300 / opts.speed, ctx.signal);
        }
        if (c.id === 'linux-deps' || (c.id === 'git' && ctx.platform === 'macos')) {
          await ctx.elevate(
            'Administrator permission is needed to install system packages. Your OS will ask for your password.',
          );
        }
        ctx.step('install', 'Installing…');
        for (let p = 60; p < 95; p += 7) {
          await sleep(250 / opts.speed, ctx.signal);
          ctx.progress({ percent: p });
        }
        maybeFail(opts, c.id, 'install');
        ctx.step('configure', 'Configuring…');
        await sleep(400 / opts.speed, ctx.signal);
        if (c.id === 'verify') {
          const flutter = ctx.manifest.components.find((x) => x.id === 'flutter');
          const out = SIM_DOCTOR(flutter?.id === 'flutter' ? flutter.version : '3.35.4');
          ctx.facts.doctorOutput = out;
          ctx.facts.doctor = parseFlutterDoctor(out);
          ctx.facts.doctorEval = evaluateDoctor(ctx.facts.doctor, {
            androidRequired: Boolean(
              ctx.manifest.components.find((x) => x.id === 'android')?.enabled,
            ),
            vscodeVerifiedLocally: true,
          });
        }
        ctx.facts.simulated = { ...ctx.facts.simulated, [c.id]: versionOf(c) ?? '' };
        if (c.id === 'warmup') ctx.facts.projectDir = join(ctx.dirs.projects, 'starter_app');
        ctx.save();
      },
      async verify(c, ctx) {
        const v = ctx.facts.simulated?.[c.id];
        return v !== undefined
          ? { ok: true, version: v || undefined }
          : { ok: false, detail: 'not installed (simulated)' };
      },
    };
  }
  return runners;
}
