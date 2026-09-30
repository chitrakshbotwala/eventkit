import { app } from 'electron';
import {
  canonicalJson,
  evaluateReadiness,
  ReadinessResponseSchema,
  type ReadinessReport,
} from '@eventkit/shared';
import { hmacSha256Hex } from '@eventkit/shared/node';
import { api, ApiError } from './api';
import { auth } from './auth';
import { config } from './config';
import { clientDeviceId, currentArch, currentPlatform, osVersion } from './device';
import { errMsg, logger } from './logger';
import { secureStore } from './secure-store';
import type { SetupEngine } from './setup/engine';

const log = logger.scope('readiness');

export function buildReport(engine: SetupEngine): ReadinessReport | null {
  const manifest = engine.currentManifest;
  const snap = engine.snapshot();
  if (!manifest) return null;
  return {
    manifestId: manifest.manifestId,
    clientDeviceId: clientDeviceId(),
    generatedAt: new Date(Date.now() + api.serverOffsetMs).toISOString(),
    appVersion: app.getVersion(),
    os: currentPlatform(),
    arch: currentArch(),
    osVersion: osVersion(),
    components: snap.components.map((c) => ({
      id: c.id,
      status: c.status,
      version: c.version?.slice(0, 100),
      detail: (c.error ?? undefined)?.slice(0, 500),
    })),
    doctor: engine.facts.doctor ?? { categories: [] },
  };
}

/**
 * Send a signed readiness report. The server re-checks it and, only when it
 * passes, returns the per-attendee QR secret (kept in safeStorage).
 * `force` also reports regressions so the server stops accepting scans.
 */
export async function submitReadiness(engine: SetupEngine, opts: { force?: boolean } = {}): Promise<void> {
  const report = buildReport(engine);
  const key = auth.deviceKey;
  if (!report || !key || !auth.state().signedIn) return;
  const manifest = engine.currentManifest!;
  if (manifest.placeholder && !config.simulate) return;

  const local = evaluateReadiness(report, manifest);
  if (!local.passed && !opts.force) {
    engine.setReadiness({ state: 'not_ready', reasons: local.reasons, checkedAt: new Date().toISOString() });
    return;
  }
  engine.setReadiness({ state: 'submitting', reasons: [], checkedAt: new Date().toISOString() });
  try {
    const res = await api.request('/api/readiness', ReadinessResponseSchema, {
      auth: true,
      body: { report, signature: hmacSha256Hex(key, canonicalJson(report)) },
    });
    if (res.accepted && res.qrSecret) {
      secureStore.set('qrSecret', res.qrSecret);
      auth.patchProfile({ status: 'ready', ready: true });
      log.info('readiness accepted: QR unlocked');
      engine.setReadiness({ state: 'accepted', reasons: [], checkedAt: new Date().toISOString() });
    } else {
      auth.patchProfile({ status: 'not_ready', ready: false });
      log.warn(`readiness rejected: ${res.reasons.join('; ')}`);
      engine.setReadiness({ state: 'rejected', reasons: res.reasons, checkedAt: new Date().toISOString() });
    }
  } catch (err) {
    const offline = err instanceof ApiError && err.offline;
    log.warn(`readiness submission failed: ${errMsg(err)}`);
    engine.setReadiness({
      state: offline ? 'offline' : 'rejected',
      reasons: offline ? ['Could not reach the event server. Connect to the internet and try again.'] : [errMsg(err)],
      checkedAt: new Date().toISOString(),
    });
  }
}
