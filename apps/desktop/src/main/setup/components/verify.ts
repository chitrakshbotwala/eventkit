import {
  evaluateDoctor,
  findComponent,
  parseFlutterDoctor,
  type ComponentOf,
} from '@eventkit/shared';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ComponentContext, ComponentRunner } from '../types';
import { COMPONENT_WEIGHTS, dependsOnFor } from './meta';
import { flutter, hasFlutter } from './util';

/** Run `flutter doctor -v`, parse it and apply the gating policy. */
export async function runDoctor(ctx: ComponentContext) {
  const res = await flutter(ctx, ['doctor', '-v'], { timeoutMs: 10 * 60_000, allowFailure: true });
  const output = `${res.stdout}\n${res.stderr}`.trim();
  const summary = parseFlutterDoctor(res.stdout);
  const vscodeVerified = ctx.manifest.components.some((c) => c.id === 'vscode' && c.enabled)
    ? Boolean(ctx.facts.vscodeCli)
    : true;
  const evaluation = evaluateDoctor(summary, {
    androidRequired: Boolean(findComponent(ctx.manifest, 'android')?.enabled),
    vscodeVerifiedLocally: vscodeVerified,
    androidLicensesVerifiedLocally: existsSync(
      join(ctx.dirs.androidSdk, 'licenses', 'android-sdk-license'),
    ),
  });
  ctx.facts.doctorOutput = output;
  ctx.facts.doctor = summary;
  ctx.facts.doctorEval = evaluation;
  ctx.save();
  return evaluation;
}

export const verifyRunner: ComponentRunner<ComponentOf<'verify'>> = {
  id: 'verify',
  weight: COMPONENT_WEIGHTS.verify,
  dependsOn: (c, m) => dependsOnFor(c, m),
  artifacts: () => [],
  // Always re-run the doctor on a setup run.
  detect: async () => ({ installed: false }),
  install: async (_c, ctx) => {
    ctx.step('verify', 'Running flutter doctor -v');
  },
  async verify(_c, ctx) {
    if (!hasFlutter(ctx)) return { ok: false, detail: 'Flutter not installed' };
    const e = await runDoctor(ctx);
    if (!e.passed) return { ok: false, detail: e.failures.join('; ') };
    return { ok: true, version: ctx.facts.doctor?.flutterVersion };
  },
};
