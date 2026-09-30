import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AdminCreateUserBodySchema,
  AdminUpdateUserBodySchema,
  type AuditLogRow,
} from '@eventkit/shared';
import { badRequest, conflict, notFound, parse } from '../../lib/errors';
import { hashPassword } from '../../lib/passwords';
import { jsonParse } from '../../lib/util';
import { requireAdmin } from '../../plugins/auth';
import { audit } from '../../services/audit';
import { adminDto } from './auth';

export async function adminUserRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const superadmin = requireAdmin('superadmin');

  app.get('/admin/users', { preHandler: superadmin }, async () => {
    const users = await ctx.prisma.adminUser.findMany({ orderBy: { createdAt: 'asc' } });
    return { items: users.map(adminDto) };
  });

  app.post('/admin/users', { preHandler: superadmin }, async (req) => {
    const body = parse(AdminCreateUserBodySchema, req.body);
    if (await ctx.prisma.adminUser.findUnique({ where: { email: body.email } })) {
      throw conflict('duplicate_email', 'An admin with this email already exists');
    }
    const u = await ctx.prisma.adminUser.create({
      data: {
        email: body.email,
        name: body.name,
        role: body.role,
        passwordHash: await hashPassword(body.password),
      },
    });
    await audit(ctx.prisma, {
      actorType: 'admin',
      actorId: req.admin!.id,
      actorLabel: req.admin!.email,
      action: 'admin_user.create',
      target: u.id,
      data: { email: u.email, role: u.role },
      ip: req.ip,
    });
    return { user: adminDto(u) };
  });

  app.patch<{ Params: { id: string } }>(
    '/admin/users/:id',
    { preHandler: superadmin },
    async (req) => {
      const body = parse(AdminUpdateUserBodySchema, req.body);
      const target = await ctx.prisma.adminUser.findUnique({ where: { id: req.params.id } });
      if (!target) throw notFound('Admin not found');
      if (
        target.id === req.admin!.id &&
        (body.disabled || (body.role && body.role !== 'superadmin'))
      ) {
        throw badRequest('self_lockout', 'You cannot disable or demote yourself');
      }
      const u = await ctx.prisma.adminUser.update({
        where: { id: target.id },
        data: {
          name: body.name,
          role: body.role,
          disabled: body.disabled,
          ...(body.password ? { passwordHash: await hashPassword(body.password) } : {}),
        },
      });
      if (body.disabled || body.password)
        await ctx.prisma.adminSession.deleteMany({ where: { adminId: u.id } });
      await audit(ctx.prisma, {
        actorType: 'admin',
        actorId: req.admin!.id,
        actorLabel: req.admin!.email,
        action: 'admin_user.update',
        target: u.id,
        data: {
          name: body.name,
          role: body.role,
          disabled: body.disabled,
          passwordChanged: Boolean(body.password),
        },
        ip: req.ip,
      });
      return { user: adminDto(u) };
    },
  );

  app.get('/admin/audit', { preHandler: superadmin }, async (req) => {
    const q = parse(
      z.object({
        action: z.string().max(100).optional(),
        before: z.iso.datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const rows = await ctx.prisma.auditLog.findMany({
      where: {
        ...(q.action ? { action: { startsWith: q.action } } : {}),
        ...(q.before ? { createdAt: { lt: new Date(q.before) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });
    const items: AuditLogRow[] = rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      actorType: r.actorType,
      actorId: r.actorId,
      actorLabel: r.actorLabel,
      action: r.action,
      target: r.target,
      data: jsonParse<unknown>(r.data, {}),
      ip: r.ip,
    }));
    return { items };
  });
}
