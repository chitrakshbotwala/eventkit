import { randomInt } from 'node:crypto';
import {
  ATTENDEE_SESSION_TTL_MS,
  OTP_COOLDOWN_MS,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_PER_WINDOW,
  OTP_TTL_MS,
  OTP_WINDOW_MS,
  type DeviceInfo,
  type VerifyOtpResponse,
} from '@eventkit/shared';
import { randomKeyB64, randomTokenB64Url, safeEqual } from '@eventkit/shared/node';
import type { AppContext } from '../context';
import { badRequest, tooMany } from '../lib/errors';
import { hashToken, hmacHex, SlidingWindowLimiter } from '../lib/util';
import { audit } from './audit';
import { toProfile } from './attendees';

const perEmail = new SlidingWindowLimiter(OTP_MAX_PER_WINDOW, OTP_WINDOW_MS);

export function resetOtpLimiter() {
  (perEmail as unknown as { hits: Map<string, number[]> }).hits.clear();
}

const codeHash = (ctx: AppContext, email: string, code: string) =>
  hmacHex(ctx.env.OTP_PEPPER, `otp:${email}:${code}`);

export function genericOtpMessage(ctx: AppContext) {
  return `If this email is on the RSVP list, a 6-digit code is on its way. ${ctx.env.CONTACT_HINT}`;
}

/**
 * Issue an OTP. Always behaves the same for known and unknown emails
 * (same response, same rate limits) to avoid email enumeration.
 */
export async function requestOtp(ctx: AppContext, email: string, ip: string): Promise<void> {
  const now = ctx.now();
  const key = hmacHex(ctx.env.OTP_PEPPER, `rl:${email}`);
  const last = perEmail.last(key);
  if (last && now - last < OTP_COOLDOWN_MS) {
    throw tooMany(
      'Please wait before requesting another code',
      Math.ceil((OTP_COOLDOWN_MS - (now - last)) / 1000),
    );
  }
  const wait = perEmail.take(key, now);
  if (wait > 0) throw tooMany('Too many codes requested. Try again later.', wait);

  const event = await ctx.event();
  const attendee = await ctx.prisma.attendee.findUnique({
    where: { eventId_email: { eventId: event.id, email } },
  });
  if (!attendee) {
    await audit(ctx.prisma, { actorType: 'system', action: 'otp.request_unknown', ip });
    return;
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  await ctx.prisma.$transaction([
    ctx.prisma.otpCode.updateMany({
      where: { email, consumedAt: null },
      data: { consumedAt: new Date(now) },
    }),
    ctx.prisma.otpCode.create({
      data: {
        email,
        codeHash: codeHash(ctx, email, code),
        expiresAt: new Date(now + OTP_TTL_MS),
        ip,
      },
    }),
  ]);
  await ctx.mailer.send(
    email,
    `${code} is your ${ctx.env.EVENT_NAME} sign-in code`,
    `Hi ${attendee.name},\n\nYour sign-in code is ${code}. It expires in ${OTP_TTL_MS / 60_000} minutes.\n\nIf you did not request this, ignore this email.`,
  );
  await audit(ctx.prisma, {
    actorType: 'attendee',
    actorId: attendee.id,
    action: 'otp.request',
    ip,
  });
}

export async function verifyOtp(
  ctx: AppContext,
  email: string,
  code: string,
  device: DeviceInfo,
  ip: string,
): Promise<VerifyOtpResponse> {
  const now = ctx.now();
  const otp = await ctx.prisma.otpCode.findFirst({
    where: { email, consumedAt: null, expiresAt: { gt: new Date(now) } },
    orderBy: { createdAt: 'desc' },
  });
  const invalid = () => badRequest('invalid_code', 'That code is invalid or has expired.');
  if (!otp) throw invalid();
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    await ctx.prisma.otpCode.update({ where: { id: otp.id }, data: { consumedAt: new Date(now) } });
    throw badRequest('too_many_attempts', 'Too many attempts. Request a new code.');
  }
  if (!safeEqual(otp.codeHash, codeHash(ctx, email, code))) {
    const attempts = otp.attempts + 1;
    await ctx.prisma.otpCode.update({
      where: { id: otp.id },
      data: { attempts, consumedAt: attempts >= OTP_MAX_ATTEMPTS ? new Date(now) : null },
    });
    throw invalid();
  }

  const event = await ctx.event();
  const attendee = await ctx.prisma.attendee.findUnique({
    where: { eventId_email: { eventId: event.id, email } },
    include: { attendance: true },
  });
  // Consume first so a code can never be used twice, even if later steps fail.
  const consumed = await ctx.prisma.otpCode.updateMany({
    where: { id: otp.id, consumedAt: null },
    data: { consumedAt: new Date(now) },
  });
  if (consumed.count !== 1 || !attendee) throw invalid();

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
    data: { os: device.os, arch: device.arch, appVersion: device.appVersion },
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
