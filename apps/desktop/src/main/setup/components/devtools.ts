import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentOf } from '@eventkit/shared';
import { dartExe } from '../paths';
import { SetupError, type ComponentContext, type ComponentRunner } from '../types';
import { COMPONENT_WEIGHTS } from './meta';
import { flutterVersion } from './util';

function assetsDir(ctx: ComponentContext) {
  return join(ctx.dirs.flutter, 'bin', 'cache', 'dart-sdk', 'bin', 'resources', 'devtools');
}

/**
 * Flutter DevTools ships inside the Dart SDK. Verify the assets exist and that
 * `dart devtools` actually starts its server (then stop it).
 */
async function launchCheck(ctx: ComponentContext): Promise<boolean> {
  const dart = dartExe(ctx.dirs, ctx.platform);
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  ctx.signal.addEventListener('abort', onOuter, { once: true });
  let started = false;
  try {
    await ctx.exec.run(dart, ['devtools', '--machine', '--no-launch-browser'], {
      env: ctx.env.childEnv(),
      signal: ctrl.signal,
      timeoutMs: 90_000,
      allowFailure: true,
      onLine: (l) => {
        ctx.log.debug(`  devtools: ${l}`);
        if (/server\.started/.test(l)) {
          started = true;
          ctrl.abort();
        }
      },
    });
  } catch {
    // aborting the process after it started is the expected path
  } finally {
    ctx.signal.removeEventListener('abort', onOuter);
  }
  return started;
}

export const devtoolsRunner: ComponentRunner<ComponentOf<'devtools'>> = {
  id: 'devtools',
  weight: COMPONENT_WEIGHTS.devtools,
  dependsOn: () => ['flutter'],
  artifacts: () => [],
  detect: async (_c, ctx) => ({
    installed: existsSync(dartExe(ctx.dirs, ctx.platform)) && existsSync(assetsDir(ctx)),
  }),
  async install(_c, ctx) {
    if (!existsSync(dartExe(ctx.dirs, ctx.platform))) {
      throw new SetupError(
        'The Dart SDK inside Flutter is missing.',
        'Use "Repair" to reinstall Flutter.',
      );
    }
  },
  async verify(_c, ctx) {
    if (!existsSync(dartExe(ctx.dirs, ctx.platform)))
      return { ok: false, detail: 'dart not found' };
    if (!existsSync(assetsDir(ctx)))
      return { ok: false, detail: 'DevTools assets missing from the Dart SDK' };
    if (!ctx.quick && !(await launchCheck(ctx)))
      return { ok: false, detail: '`dart devtools` did not start' };
    if (!ctx.facts.devtoolsVersion) await flutterVersion(ctx);
    return { ok: true, version: ctx.facts.devtoolsVersion };
  },
};
