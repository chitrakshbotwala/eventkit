import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComponentOf } from '@eventkit/shared';
import { extractZipSafe, renameRetry, replaceDir } from '../extract';
import { SetupError, type ComponentContext, type ComponentRunner } from '../types';
import { COMPONENT_WEIGHTS } from './meta';
import { flutter } from './util';

const MARKER = '.eventkit-starter';
const DEFAULT_PROJECT = 'offline_app';

function projectDir(c: ComponentOf<'warmup'>, ctx: ComponentContext) {
  return join(ctx.dirs.projects, c.starter?.projectName ?? DEFAULT_PROJECT);
}

const markerValue = (c: ComponentOf<'warmup'>) => c.starter?.sha256 ?? 'generated';

async function markerMatches(c: ComponentOf<'warmup'>, dir: string) {
  try {
    return (await readFile(join(dir, MARKER), 'utf8')).trim() === markerValue(c);
  } catch {
    return false;
  }
}

/** Find the folder containing pubspec.yaml (zip root or a single top-level folder). */
async function findProjectRoot(dir: string): Promise<string | null> {
  if (existsSync(join(dir, 'pubspec.yaml'))) return dir;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory() && existsSync(join(dir, e.name, 'pubspec.yaml'))) return join(dir, e.name);
  }
  return null;
}

export const warmupRunner: ComponentRunner<ComponentOf<'warmup'>> = {
  id: 'warmup',
  weight: COMPONENT_WEIGHTS.warmup,
  dependsOn: (c) => (c.gradleWarmup ? ['flutter', 'android'] : ['flutter']),
  artifacts: (c) =>
    c.starter
      ? [
          {
            url: c.starter.url,
            sha256: c.starter.sha256,
            size: c.starter.size,
            fileName: c.starter.fileName,
            kind: 'zip',
            installArgs: [],
          },
        ]
      : [],
  async detect(c, ctx) {
    const dir = projectDir(c, ctx);
    const ok = existsSync(join(dir, 'pubspec.yaml')) && (await markerMatches(c, dir));
    if (ok) ctx.facts.projectDir = dir;
    return { installed: ok, path: dir };
  },
  async install(c, ctx) {
    const dir = projectDir(c, ctx);
    await mkdir(ctx.dirs.projects, { recursive: true });
    if (existsSync(dir) && !(await markerMatches(c, dir))) {
      // Never delete attendee work: keep the previous copy next to the new one.
      const backup = `${dir}-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await renameRetry(dir, backup);
      ctx.log.info(`kept previous project at ${backup}`);
    }
    if (!existsSync(dir)) {
      if (c.starter) {
        ctx.step('download', 'Downloading the starter project');
        const zip = await ctx.download({
          url: c.starter.url,
          sha256: c.starter.sha256,
          size: c.starter.size,
          fileName: c.starter.fileName,
          kind: 'zip',
          installArgs: [],
        });
        ctx.step('install', 'Extracting the starter project');
        const staging = join(ctx.dirs.staging, 'starter');
        await extractZipSafe(zip, staging);
        const root = await findProjectRoot(staging);
        if (!root) throw new SetupError('The starter project zip has no pubspec.yaml');
        await replaceDir(root, dir);
      } else {
        ctx.step('install', 'Creating a sample Flutter project');
        await flutter(
          ctx,
          ['create', '--org', 'dev.eventkit', '--project-name', DEFAULT_PROJECT, dir],
          { timeoutMs: 15 * 60_000 },
        );
      }
      await writeFile(join(dir, MARKER), markerValue(c));
    }
    ctx.facts.projectDir = dir;
    ctx.save();

    ctx.step('configure', 'Downloading packages for offline use (flutter pub get)');
    ctx.progress({ percent: 70 });
    await flutter(ctx, ['pub', 'get'], { cwd: dir, timeoutMs: 20 * 60_000 });
    if (c.gradleWarmup) {
      ctx.progress({
        percent: 80,
        message: 'Warming the Gradle cache (flutter build apk --debug, takes a while)…',
      });
      await flutter(ctx, ['build', 'apk', '--debug'], { cwd: dir, timeoutMs: 90 * 60_000 });
    }
    ctx.progress({
      percent: 95,
      message: 'Checking the project builds offline (pub get --offline)',
    });
  },
  async verify(c, ctx) {
    const dir = projectDir(c, ctx);
    if (!existsSync(join(dir, 'pubspec.yaml')))
      return { ok: false, detail: 'starter project missing' };
    ctx.facts.projectDir = dir;
    if (ctx.quick) {
      return existsSync(join(dir, '.dart_tool', 'package_config.json'))
        ? { ok: true }
        : { ok: false, detail: 'packages not fetched' };
    }
    const res = await flutter(ctx, ['pub', 'get', '--offline'], {
      cwd: dir,
      timeoutMs: 10 * 60_000,
      allowFailure: true,
    });
    return res.code === 0
      ? { ok: true }
      : { ok: false, detail: 'flutter pub get --offline failed (pub cache incomplete)' };
  },
};
