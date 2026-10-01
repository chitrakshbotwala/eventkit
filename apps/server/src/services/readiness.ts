import type { Attendee, Device } from '@prisma/client';
import {
  canonicalJson,
  evaluateReadiness,
  type ReadinessBody,
  type ReadinessResponse,
} from '@eventkit/shared';
import { hmacSha256Hex, randomKeyB64, safeEqual } from '@eventkit/shared/node';
import type { AppContext } from '../context';
import { badRequest } from '../lib/errors';
import { audit } from './audit';
import { publishCounters } from './counters';
import { manifestPayloadFor } from './manifest/service';

const MAX_REPORT_AGE_MS = 60 * 60_000;

/**
 * Server-side readiness gate. The device HMAC-signs its report; the server
 * re-evaluates it against the CURRENT manifest (not the client's opinion) and
 * only then releases the per-attendee QR secret. Without that secret no valid
 * QR can exist, so the gate holds even if the desktop UI is bypassed.
 */
export async function submitReadiness(
  ctx: AppContext,
  attendee: Attendee,
  device: Device,
  body: ReadinessBody,
  ip: string,
): Promise<ReadinessResponse> {
  const { report, signature } = body;
  const expected = hmacSha256Hex(Buffer.from(device.deviceKey, 'base64'), canonicalJson(report));
  if (!safeEqual(expected, signature))
    throw badRequest('bad_signature', 'Readiness report signature invalid');
  if (report.clientDeviceId !== device.clientDeviceId)
    throw badRequest('device_mismatch', 'Report is for another device');
  const age = Math.abs(ctx.now() - Date.parse(report.generatedAt));
  if (!Number.isFinite(age) || age > MAX_REPORT_AGE_MS)
    throw badRequest('stale_report', 'Readiness report is too old; re-run verification');

  const manifest = await manifestPayloadFor(ctx, report.os, report.arch);
  const evaluation = evaluateReadiness(report, manifest);

  await ctx.prisma.readinessReport.create({
    data: {
      attendeeId: attendee.id,
      deviceId: device.id,
      accepted: evaluation.passed,
      reasons: JSON.stringify(evaluation.reasons),
      report: JSON.stringify(report),
      manifestId: manifest.manifestId,
    },
  });
  await ctx.prisma.device.update({
    where: { id: device.id },
    data: {
      appVersion: report.appVersion,
      osVersion: report.osVersion,
      lastSeenAt: new Date(ctx.now()),
    },
  });

  let qrSecret: string | undefined;
  if (evaluation.passed) {
    qrSecret = attendee.qrSecret ?? randomKeyB64(32);
    await ctx.prisma.attendee.update({
      where: { id: attendee.id },
      data: { qrSecret, status: 'ready', readyAt: attendee.readyAt ?? new Date(ctx.now()) },
    });
  } else if (
    attendee.status === 'ready' ||
    attendee.status === 'logged_in' ||
    attendee.status === 'invited'
  ) {
    // A regression (e.g. SDK deleted) revokes readiness: scans are refused until repaired.
    await ctx.prisma.attendee.update({ where: { id: attendee.id }, data: { status: 'not_ready' } });
  }

  await audit(ctx.prisma, {
    actorType: 'attendee',
    actorId: attendee.id,
    action: evaluation.passed ? 'readiness.accepted' : 'readiness.rejected',
    target: device.id,
    data: { manifestId: manifest.manifestId, reasons: evaluation.reasons.slice(0, 10) },
    ip,
  });
  ctx.hub.publish({
    type: 'readiness',
    data: { attendeeId: attendee.id, accepted: evaluation.passed },
  });
  publishCounters(ctx);

  return {
    accepted: evaluation.passed,
    reasons: evaluation.reasons,
    qrSecret,
    attendeeId: attendee.id,
  };
}
