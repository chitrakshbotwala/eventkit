import { createHash } from 'node:crypto';
import {
  ATTENDEE_SESSION_TTL_MS,
  SIGNIN_CODE_TTL_MS,
  SIGNIN_REQUEST_TTL_MS,
  type DeviceInfo,
  type SignInErrorCode,
  type SignInResponse,
  type SignInStartQuery,
} from '@eventkit/shared';
import { randomKeyB64, randomTokenB64Url, safeEqual, sha256Hex } from '@eventkit/shared/node';
import type { SignInRequest } from '@prisma/client';
import type { AppContext } from '../context';
import { badRequest } from '../lib/errors';
import { hashToken } from '../lib/util';
import { audit } from './audit';
import { toProfile } from './attendees';

/*
 * "Sign in with Google" for the desktop app (OAuth 2.0 for native apps, RFC 8252):
 *
 *  1. The app starts a listener on 127.0.0.1:<port>, makes a PKCE verifier and opens
 *     /auth/google/start?port&challenge&state in the system browser.
 *  2. The server redirects to Google (its own PKCE + nonce; the client secret stays here).
 *  3. Google redirects back to /auth/google/callback. The server checks the verified email
 *     against the RSVP list and redirects the browser to the app's listener with a
 *     one-time code (or an error).
 *  4. The app redeems the code with its PKCE verifier at /auth/google/exchange and gets a
 *     session. A stolen code is useless without the verifier, which never leaves the app.
 */

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export function loopbackUrl(port: number, params: Record<string, string>) {
  return `http://127.0.0.1:${port}/callback?${new URLSearchParams(params).toString()}`;
}

export async function startSignIn(ctx: AppContext, q: SignInStartQuery, ip: string) {
  const now = ctx.now();
  await ctx.prisma.signInRequest.deleteMany({
    where: { expiresAt: { lt: new Date(now - 3600_000) } },
  });
  const state = randomTokenB64Url(32);
  const nonce = randomTokenB64Url(16);
  const googleVerifier = randomTokenB64Url(32);
  await ctx.prisma.signInRequest.create({
    data: {
      stateHash: sha256Hex(state),
      nonce,
      googleVerifier,
      appChallenge: q.challenge,
      appState: q.state,
      redirectPort: q.port,
      expiresAt: new Date(now + SIGNIN_REQUEST_TTL_MS),
      ip,
    },
  });
  return ctx.identity.authorizeUrl({ state, nonce, codeChallenge: s256(googleVerifier) });
}

export type CallbackResult = { redirect: string } | { page: 'invalid' };

/** Handle Google's redirect. Always ends at the app's listener unless the request is unknown. */
export async function finishSignIn(
  ctx: AppContext,
  q: { code?: string; state?: string; error?: string },
  ip: string,
): Promise<CallbackResult> {
  const now = ctx.now();
  if (!q.state) return { page: 'invalid' };
  const req = await ctx.prisma.signInRequest.findUnique({
    where: { stateHash: sha256Hex(q.state) },
  });
  if (!req || req.codeHash || req.consumedAt) return { page: 'invalid' };

  const fail = async (error: SignInErrorCode, message: string, email?: string) => {
    await ctx.prisma.signInRequest.update({
      where: { id: req.id },
      data: { consumedAt: new Date(now) },
    });
    return {
      redirect: loopbackUrl(req.redirectPort, {
        state: req.appState,
        error,
        message,
        ...(email ? { email } : {}),
      }),
    };
  };

  if (req.expiresAt.getTime() < now) {
    return fail('expired', 'The sign-in took too long. Please try again.');
  }
  if (q.error || !q.code) return fail('cancelled', 'Sign-in was cancelled.');

  let identity;
  try {
    identity = await ctx.identity.exchange({
      code: q.code,
      codeVerifier: req.googleVerifier,
      nonce: req.nonce,
    });
  } catch (err) {
    ctx.log.warn(`google sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail('failed', 'Google sign-in failed. Please try again.');
  }
  if (!identity.emailVerified) {
    return fail('email_unverified', 'This Google account has no verified email address.');
  }

  const event = await ctx.event();
  const attendee = await ctx.prisma.attendee.findUnique({
    where: { eventId_email: { eventId: event.id, email: identity.email } },
  });
  if (!attendee) {
    await audit(ctx.prisma, {
      actorType: 'system',
      action: 'auth.not_registered',
      data: { domain: identity.email.split('@')[1] ?? '' },
      ip,
    });
    return fail(
      'not_registered',
      `${identity.email} is not on the RSVP list. Sign in with the Google account you registered with. ${ctx.env.CONTACT_HINT}`,
      identity.email,
    );
  }

  const code = randomTokenB64Url(32);
  const updated = await ctx.prisma.signInRequest.updateMany({
    where: { id: req.id, codeHash: null, consumedAt: null },
    data: {
      attendeeId: attendee.id,
      codeHash: hashToken(code),
      codeExpiresAt: new Date(now + SIGNIN_CODE_TTL_MS),
    },
  });
  if (updated.count !== 1) return { page: 'invalid' };
  return { redirect: loopbackUrl(req.redirectPort, { state: req.appState, code }) };
}

/** Redeem the one-time code (single use, short-lived, bound to the app's PKCE verifier). */
export async function exchangeSignIn(
  ctx: AppContext,
  body: { code: string; verifier: string; device: DeviceInfo },
  ip: string,
): Promise<SignInResponse> {
  const now = ctx.now();
  const invalid = () => badRequest('invalid_code', 'This sign-in has expired. Please try again.');
  const req: SignInRequest | null = await ctx.prisma.signInRequest.findUnique({
    where: { codeHash: hashToken(body.code) },
  });
  if (!req || !req.attendeeId || req.consumedAt) throw invalid();
  // Consume first so a code can never be used twice, even if the verifier is wrong.
  const consumed = await ctx.prisma.signInRequest.updateMany({
    where: { id: req.id, consumedAt: null },
    data: { consumedAt: new Date(now) },
  });
  if (consumed.count !== 1) throw invalid();
  if (!req.codeExpiresAt || req.codeExpiresAt.getTime() < now) throw invalid();
  if (!safeEqual(s256(body.verifier), req.appChallenge)) throw invalid();
  return createSession(ctx, req.attendeeId, body.device, ip);
}

export async function createSession(
  ctx: AppContext,
  attendeeId: string,
  device: DeviceInfo,
  ip: string,
): Promise<SignInResponse> {
  const now = ctx.now();
  const attendee = await ctx.prisma.attendee.findUniqueOrThrow({
    where: { id: attendeeId },
    include: { attendance: true },
  });
  const dev = await ctx.prisma.device.upsert({
    where: {
      attendeeId_clientDeviceId: { attendeeId: attendee.id, clientDeviceId: device.clientDeviceId },
    },
    create: {
      attendeeId: attendee.id,
      clientDeviceId: device.clientDeviceId,
      deviceKey: randomKeyB64(32),
      os: device.os,
      arch: device.arch,
      osVersion: device.osVersion,
      hostname: device.hostname,
      appVersion: device.appVersion,
    },
    update: {
      os: device.os,
      arch: device.arch,
      osVersion: device.osVersion,
      hostname: device.hostname,
      appVersion: device.appVersion,
      lastSeenAt: new Date(now),
    },
  });

  const token = randomTokenB64Url(32);
  const expiresAt = new Date(now + ATTENDEE_SESSION_TTL_MS);
  await ctx.prisma.session.create({
    data: { attendeeId: attendee.id, deviceId: dev.id, tokenHash: hashToken(token), expiresAt },
  });
  const updated =
    attendee.status === 'invited'
      ? await ctx.prisma.attendee.update({
          where: { id: attendee.id },
          data: { status: 'logged_in', lastSeenAt: new Date(now) },
          include: { attendance: true },
        })
      : attendee;
  await audit(ctx.prisma, {
    actorType: 'attendee',
    actorId: attendee.id,
    action: 'auth.login',
    target: dev.id,
    data: {
      method: ctx.identity.kind,
      os: device.os,
      arch: device.arch,
      appVersion: device.appVersion,
    },
    ip,
  });

  return {
    token,
    expiresAt: expiresAt.toISOString(),
    attendee: toProfile(updated),
    deviceId: dev.id,
    deviceKey: dev.deviceKey,
    serverTime: ctx.now(),
  };
}
