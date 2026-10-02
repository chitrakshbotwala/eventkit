import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { majorOf, type ComponentOf } from '@eventkit/shared';
import { extractArchive, replaceDir, singleChild } from '../extract';
import { exe, javaHome } from '../paths';
import { SetupError, type ComponentContext, type ComponentRunner } from '../types';
import { adopt, findExistingJdk, MAX_JAVA_MAJOR, release } from './existing';
import { COMPONENT_WEIGHTS } from './meta';
import { flutter, hasFlutter, tryRun } from './util';

function javaExe(ctx: ComponentContext) {
  return join(javaHome(ctx.dirs, ctx.platform), 'bin', exe(ctx.platform, 'java'));
}

async function javaVersion(ctx: ComponentContext): Promise<string | undefined> {
  if (!existsSync(javaExe(ctx))) return undefined;
  const res = await tryRun(ctx, javaExe(ctx), ['-version']);
  // `java -version` prints to stderr: openjdk version "17.0.16" 2025-07-15
  return /version "([\d._+]+)"/.exec(`${res?.stderr ?? ''}${res?.stdout ?? ''}`)?.[1];
}

function configureEnv(ctx: ComponentContext) {
  const home = javaHome(ctx.dirs, ctx.platform);
  ctx.env.setVar('JAVA_HOME', home);
  ctx.env.addPath(join(home, 'bin'));
  ctx.facts.javaHome = home;
}

export const javaRunner: ComponentRunner<ComponentOf<'java'>> = {
  id: 'java',
  weight: COMPONENT_WEIGHTS.java,
  dependsOn: () => ['system'],
  artifacts: (c) => [c.artifact],
  async detect(c, ctx) {
    if (!existsSync(javaExe(ctx))) {
      const existing = await findExistingJdk(c, ctx);
      if (existing) adopt(ctx, 'jdk', existing);
    }
    const v = await javaVersion(ctx);
    return v ? { installed: true, version: v } : { installed: false };
  },
  async install(c, ctx) {
    release(ctx, 'jdk');
    ctx.step('download', 'Downloading Temurin JDK 17');
    const archive = await ctx.download(c.artifact);
    ctx.step('install', 'Extracting JDK');
    const staging = join(ctx.dirs.staging, 'jdk');
    await extractArchive(archive, staging, c.artifact.kind, ctx.platform, { signal: ctx.signal });
    const root = await singleChild(staging);
    const probe =
      ctx.platform === 'macos' ? join(root, 'Contents', 'Home', 'bin') : join(root, 'bin');
    if (!existsSync(probe)) throw new SetupError('JDK archive layout unexpected');
    await replaceDir(root, ctx.dirs.jdk);
    ctx.step('configure', 'Setting JAVA_HOME');
    configureEnv(ctx);
    if (hasFlutter(ctx))
      await flutter(ctx, ['config', `--jdk-dir=${javaHome(ctx.dirs, ctx.platform)}`]);
  },
  async verify(c, ctx) {
    const v = await javaVersion(ctx);
    if (!v) return { ok: false, detail: 'JDK not found' };
    configureEnv(ctx);
    const major = majorOf(v) ?? 0;
    if (major < c.majorVersion)
      return { ok: false, version: v, detail: `Java ${v} < ${c.majorVersion}` };
    if (major > MAX_JAVA_MAJOR)
      return { ok: false, version: v, detail: `Java ${v} is newer than Gradle supports` };
    return { ok: true, version: v };
  },
};
