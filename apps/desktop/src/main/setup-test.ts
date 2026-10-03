import { app } from 'electron';
import { writeFileSync } from 'node:fs';
import { evaluateReadiness } from '@eventkit/shared';
import { errMsg, logger } from './logger';
import { buildReport } from './readiness';
import type { SetupEngine } from './setup/engine';

const log = logger.scope('setup-test');

/**
 * CI runs a packaged build with EVENTKIT_SETUP_TEST=<result file> on a fresh machine: the
 * app runs the real setup against the live manifest (no sign-in needed), checks the
 * result with the same readiness rules the server applies, writes a report and quits.
 * Like the smoke test it uses a throwaway profile; the toolchain itself is installed for
 * real.
 */
export async function runSetupTest(engine: SetupEngine, resultFile: string) {
  const started = Date.now();
  log.info('real setup test: starting');
  let thrown: string | null = null;
  try {
    await engine.start();
  } catch (err) {
    thrown = errMsg(err);
  }
  const snap = engine.snapshot();
  const manifest = engine.currentManifest;
  const report = buildReport(engine);
  const readiness = report && manifest ? evaluateReadiness(report, manifest) : null;
  const ok = snap.complete && Boolean(readiness?.passed);
  const result = {
    ok,
    minutes: Math.round((Date.now() - started) / 6000) / 10,
    version: app.getVersion(),
    platform: `${process.platform}/${process.arch}`,
    manifestId: snap.manifestId,
    installRoot: snap.installRoot,
    error: snap.error ?? thrown,
    components: snap.components.map((c) => ({
      id: c.id,
      status: c.status,
      version: c.version ?? null,
      error: c.error ?? null,
    })),
    readiness,
    doctor: engine.facts.doctorOutput ?? null,
    log: logger
      .recent()
      .slice(-300)
      .map((l) => `${new Date(l.t).toISOString()} ${l.level} [${l.scope}] ${l.msg}`),
  };
  log.info(`real setup test: ${ok ? 'passed' : 'failed'} after ${result.minutes} min`);
  try {
    writeFileSync(resultFile, JSON.stringify(result, null, 2));
  } finally {
    app.exit(ok ? 0 : 1);
  }
}
