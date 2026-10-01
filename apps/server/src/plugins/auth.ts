import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import type { AdminRole } from '@eventkit/shared';
import { forbidden, unauthorized } from '../lib/errors';
import { hashToken } from '../lib/util';

export const ADMIN_COOKIE = 'ek_admin';

/** Attendee bearer-token auth (desktop app). */
export const requireAttendee: preHandlerHookHandler = async function (req: FastifyRequest) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (!token) throw unauthorized();
  const { prisma, now } = this.ctx;
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { attendee: true, device: true },
  });
  if (!session || session.revokedAt || session.expiresAt.getTime() < now()) {
    throw unauthorized('Session expired, please sign in again');
  }
  req.attendee = session.attendee;
  req.device = session.device;
  req.sessionId = session.id;
  // Cheap presence tracking, at most once a minute per device.
  if (now() - session.device.lastSeenAt.getTime() > 60_000) {
    const at = new Date(now());
    await prisma.$transaction([
      prisma.device.update({ where: { id: session.device.id }, data: { lastSeenAt: at } }),
      prisma.attendee.update({ where: { id: session.attendee.id }, data: { lastSeenAt: at } }),
    ]);
  }
};

async function loadAdmin(req: FastifyRequest) {
  const token = req.cookies[ADMIN_COOKIE];
  if (!token) return null;
  const { prisma, now } = req.server.ctx;
  const s = await prisma.adminSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { admin: true },
  });
  if (!s || s.expiresAt.getTime() < now() || s.admin.disabled) return null;
  return s.admin;
}

/** Cookie-session admin auth with CSRF origin check for state-changing requests. */
export function requireAdmin(...roles: AdminRole[]): preHandlerHookHandler {
  return async function (req: FastifyRequest, _reply: FastifyReply) {
    const admin = await loadAdmin(req);
    if (!admin) throw unauthorized();
    if (roles.length > 0 && !roles.includes(admin.role as AdminRole)) throw forbidden();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) checkOrigin(req);
    req.admin = admin;
  };
}

export function allowedOrigins(req: FastifyRequest): Set<string> {
  const env = req.server.ctx.env;
  const set = new Set<string>([new URL(env.PUBLIC_BASE_URL).origin]);
  for (const o of env.ADMIN_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean))
    set.add(o);
  return set;
}

/** Mutating admin requests must carry an allowed Origin (or Referer) header. */
export function checkOrigin(req: FastifyRequest) {
  const origin =
    req.headers.origin ?? (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
  if (!origin) throw forbidden('Missing Origin header');
  const allowed = allowedOrigins(req);
  const self = `${req.protocol}://${req.headers.host ?? ''}`;
  if (!allowed.has(origin) && origin !== self) throw forbidden('Cross-origin request blocked');
}
