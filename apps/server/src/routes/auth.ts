import type { FastifyInstance } from 'fastify';
import {
  RequestOtpBodySchema,
  VerifyOtpBodySchema,
  type RequestOtpResponse,
} from '@eventkit/shared';
import { parse } from '../lib/errors';
import { requireAttendee } from '../plugins/auth';
import { genericOtpMessage, requestOtp, verifyOtp } from '../services/otp';

export async function attendeeAuthRoutes(app: FastifyInstance) {
  app.post(
    '/auth/request-otp',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req): Promise<RequestOtpResponse> => {
      const { email } = parse(RequestOtpBodySchema, req.body);
      await requestOtp(app.ctx, email, req.ip);
      return { ok: true, message: genericOtpMessage(app.ctx) };
    },
  );

  app.post(
    '/auth/verify-otp',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const body = parse(VerifyOtpBodySchema, req.body);
      return verifyOtp(app.ctx, body.email, body.code, body.device, req.ip);
    },
  );

  app.post('/auth/logout', { preHandler: requireAttendee }, async (req) => {
    await app.ctx.prisma.session.update({
      where: { id: req.sessionId! },
      data: { revokedAt: new Date(app.ctx.now()) },
    });
    return { ok: true };
  });
}
