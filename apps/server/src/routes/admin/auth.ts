import type { AdminUser as AdminUserRow } from '@prisma/client';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  ADMIN_SESSION_TTL_MS,
  AdminLoginBodySchema,
  TotpConfirmBodySchema,
  type AdminLoginResponse,
  type AdminRole,
  type AdminUser,
  type TotpEnrollResponse,
} from '@eventkit/shared';
import {
  generateTotpSecret,
  otpauthUrl,
  randomTokenB64Url,
  verifyTotp,
} from '@eventkit/shared/node';
import { badRequest, parse, tooMany, unauthorized } from '../../lib/errors';
import { dummyHash, verifyPassword } from '../../lib/passwords';
import { hashToken, SlidingWindowLimiter } from '../../lib/util';
import { ADMIN_COOKIE, checkOrigin, requireAdmin } from '../../plugins/auth';
import { audit } from '../../services/audit';

export function adminDto(a: AdminUserRow): AdminUser {
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    role: a.role as AdminRole,
    totpEnabled: a.totpEnabled,
    disabled: a.disabled,
    lastLoginAt: a.lastLoginAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

const loginLimiter = new SlidingWindowLimiter(10, 15 * 60_000);

export function resetAdminLoginLimiter() {
  (loginLimiter as unknown as { hits: Map<string, number[]> }).hits.clear();
}

export async function adminAuthRoutes(app: FastifyInstance) {
  const { ctx } = app;

  const setCookie = (reply: FastifyReply, token: string) =>
    reply.setCookie(ADMIN_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.env.NODE_ENV === 'production',
      path: '/',
      maxAge: ADMIN_SESSION_TTL_MS / 1000,
    });

  app.post(
    '/admin/auth/login',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply): Promise<AdminLoginResponse> => {
      checkOrigin(req);
      const body = parse(AdminLoginBodySchema, req.body);
      const wait = loginLimiter.take(`${body.email}|${req.ip}`, ctx.now());
      if (wait > 0) throw tooMany('Too many login attempts', wait);

      const admin = await ctx.prisma.adminUser.findUnique({ where: { email: body.email } });
      const ok = admin
        ? await verifyPassword(admin.passwordHash, body.password)
        : (await verifyPassword(await dummyHash(), body.password), false);
      if (!admin || !ok || admin.disabled) {
        await audit(ctx.prisma, {
          actorType: 'system',
          action: 'admin.login_failed',
          ip: req.ip,
          data: { email: body.email },
        });
        throw unauthorized('Invalid email or password');
      }
      if (admin.totpEnabled && admin.totpSecret) {
        if (!body.totp) return { status: 'totp_required' };
        if (!verifyTotp(admin.totpSecret, body.totp, ctx.now())) {
          await audit(ctx.prisma, {
            actorType: 'admin',
            actorId: admin.id,
            action: 'admin.totp_failed',
            ip: req.ip,
          });
          throw unauthorized('Invalid authenticator code');
        }
      }
      const token = randomTokenB64Url(32);
      await ctx.prisma.adminSession.create({
        data: {
          adminId: admin.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(ctx.now() + ADMIN_SESSION_TTL_MS),
          ip: req.ip,
        },
      });
      const updated = await ctx.prisma.adminUser.update({
        where: { id: admin.id },
        data: { lastLoginAt: new Date(ctx.now()) },
      });
      await audit(ctx.prisma, {
        actorType: 'admin',
        actorId: admin.id,
        actorLabel: admin.email,
        action: 'admin.login',
        ip: req.ip,
      });
      setCookie(reply, token);
      return { status: 'ok', admin: adminDto(updated) };
    },
  );

  app.post('/admin/auth/logout', { preHandler: requireAdmin() }, async (req, reply) => {
    const token = req.cookies[ADMIN_COOKIE];
    if (token) await ctx.prisma.adminSession.deleteMany({ where: { tokenHash: hashToken(token) } });
    reply.clearCookie(ADMIN_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/admin/auth/me', { preHandler: requireAdmin() }, async (req) => ({
    admin: adminDto(req.admin!),
  }));

  app.post(
    '/admin/auth/totp/enroll',
    { preHandler: requireAdmin() },
    async (req): Promise<TotpEnrollResponse> => {
      const admin = req.admin!;
      if (admin.totpEnabled)
        throw badRequest('totp_enabled', 'Two-factor authentication is already enabled');
      const secret = generateTotpSecret();
      await ctx.prisma.adminUser.update({ where: { id: admin.id }, data: { totpSecret: secret } });
      return { secret, otpauthUrl: otpauthUrl(secret, admin.email, ctx.env.EVENT_NAME) };
    },
  );

  app.post('/admin/auth/totp/confirm', { preHandler: requireAdmin() }, async (req) => {
    const { code } = parse(TotpConfirmBodySchema, req.body);
    const admin = req.admin!;
    if (!admin.totpSecret || !verifyTotp(admin.totpSecret, code, ctx.now())) {
      throw badRequest('invalid_code', 'Code does not match');
    }
    await ctx.prisma.adminUser.update({ where: { id: admin.id }, data: { totpEnabled: true } });
    await audit(ctx.prisma, {
      actorType: 'admin',
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'admin.totp_enabled',
      ip: req.ip,
    });
    return { ok: true };
  });

  app.post('/admin/auth/totp/disable', { preHandler: requireAdmin() }, async (req) => {
    const { code } = parse(TotpConfirmBodySchema, req.body);
    const admin = req.admin!;
    if (!admin.totpEnabled || !admin.totpSecret || !verifyTotp(admin.totpSecret, code, ctx.now())) {
      throw badRequest('invalid_code', 'Code does not match');
    }
    await ctx.prisma.adminUser.update({
      where: { id: admin.id },
      data: { totpEnabled: false, totpSecret: null },
    });
    await audit(ctx.prisma, {
      actorType: 'admin',
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'admin.totp_disabled',
      ip: req.ip,
    });
    return { ok: true };
  });
}
