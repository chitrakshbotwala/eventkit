import QRCode from 'qrcode';
import { buildQrPayload, currentWindow, msUntilNextWindow } from '@eventkit/shared/node';
import type { QrView } from '../common/ipc';
import { api } from './api';
import { auth } from './auth';
import { secureStore } from './secure-store';
import type { SetupEngine } from './setup/engine';

/**
 * The QR is generated locally (works offline) from the server-issued secret:
 * payload = attendeeId + HMAC(secret, 60 s window), clock-corrected with the
 * server offset measured at login/sync. Hidden unless every required component
 * is verified locally AND the server accepted readiness.
 */
export async function currentQr(engine: SetupEngine): Promise<QrView> {
  const profile = auth.profile;
  const checkedIn = Boolean(profile?.checkedInAt);
  if (!profile) return { visible: false, reason: 'Sign in first.', checkedIn };
  if (engine.isRunning && !engine.isComplete) return { visible: false, reason: 'Setup is running…', checkedIn };
  if (!engine.isComplete) {
    const failed = engine.snapshot().components.filter((c) => c.status === 'failed');
    return {
      visible: false,
      reason: failed.length
        ? `Repair needed: ${failed.map((c) => c.name).join(', ')}.`
        : 'Finish laptop setup to unlock your attendance QR code.',
      checkedIn,
    };
  }
  const secret = secureStore.get('qrSecret');
  const readiness = engine.snapshot().readiness;
  if (!secret || !profile.ready) {
    const reason =
      readiness.state === 'offline'
        ? 'Connect to the internet once so the server can confirm your setup.'
        : readiness.state === 'rejected'
          ? `The server did not accept your setup: ${readiness.reasons.slice(0, 2).join('; ')}`
          : 'Confirming your setup with the event server…';
    return { visible: false, reason, checkedIn };
  }
  const now = Date.now();
  const window = currentWindow(now, api.serverOffsetMs);
  const payload = buildQrPayload(Buffer.from(secret, 'base64'), profile.id, window);
  const dataUrl = await QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 512 });
  return { visible: true, dataUrl, payload, expiresInMs: msUntilNextWindow(now, api.serverOffsetMs), checkedIn };
}
