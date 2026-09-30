import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SettingsUpdateBodySchema, SUPPORTED_TARGETS } from '@eventkit/shared';
import { badRequest, parse } from '../../lib/errors';
import { requireAdmin } from '../../plugins/auth';
import { audit } from '../../services/audit';
import {
  getResolveStatus,
  manifestPayloadFor,
  startResolve,
} from '../../services/manifest/service';
import { getSettings, saveSettings } from '../../services/settings';

const SmtpTestBodySchema = z.object({ to: z.email() });

export async function adminSettingsRoutes(app: FastifyInstance) {
  const { ctx } = app;
  const superadmin = requireAdmin('superadmin');
  const actor = (req: { admin?: { id: string; email: string } }) => ({
    actorType: 'admin' as const,
    actorId: req.admin!.id,
    actorLabel: req.admin!.email,
  });

  app.get('/admin/settings', { preHandler: superadmin }, async () => ({
    settings: await getSettings(ctx.prisma),
    smtpConfigured: ctx.mailer.configured,
    resolve: await getResolveStatus(ctx),
  }));

  app.put('/admin/settings', { preHandler: superadmin }, async (req) => {
    const patch = parse(SettingsUpdateBodySchema, req.body);
    const settings = await saveSettings(ctx.prisma, patch);
    await audit(ctx.prisma, { ...actor(req), action: 'settings.update', data: patch, ip: req.ip });
    return { settings };
  });

  app.post('/admin/settings/resolve-manifest', { preHandler: superadmin }, async (req) => {
    void startResolve(ctx);
    await audit(ctx.prisma, { ...actor(req), action: 'manifest.resolve', ip: req.ip });
    return { started: true };
  });

  app.get('/admin/settings/resolve-status', { preHandler: superadmin }, async () =>
    getResolveStatus(ctx),
  );

  /** Preview of what each platform would receive (unsigned). */
  app.get('/admin/settings/manifest-preview', { preHandler: superadmin }, async () => {
    const out: Record<string, unknown> = {};
    for (const { os, arch } of SUPPORTED_TARGETS) {
      try {
        out[`${os}-${arch}`] = await manifestPayloadFor(ctx, os, arch);
      } catch (err) {
        out[`${os}-${arch}`] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return out;
  });

  /** Starter project upload: raw zip body (application/zip), `?name=project_name`. */
  app.post(
    '/admin/settings/starter-project',
    { preHandler: superadmin, bodyLimit: 200 * 1024 * 1024 },
    async (req) => {
      const { name } = parse(z.object({ name: z.string().regex(/^[a-z][a-z0-9_]*$/) }), req.query);
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length < 22)
        throw badRequest('invalid_zip', 'Upload a .zip file');
      if (body.readUInt32LE(0) !== 0x04034b50)
        throw badRequest('invalid_zip', 'File is not a zip archive');
      const sha256 = createHash('sha256').update(body).digest('hex');
      const dir = resolve(ctx.env.DATA_DIR, 'starter');
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `${sha256}.zip.part`);
      await writeFile(tmp, body);
      await rename(tmp, join(dir, `${sha256}.zip`));
      const settings = await saveSettings(ctx.prisma, {
        starterProject: {
          sha256,
          size: body.length,
          fileName: `${name}.zip`,
          projectName: name,
          uploadedAt: new Date(ctx.now()).toISOString(),
        },
      });
      await audit(ctx.prisma, {
        ...actor(req),
        action: 'settings.starter_upload',
        data: { sha256, size: body.length, name },
        ip: req.ip,
      });
      return { settings };
    },
  );

  app.delete('/admin/settings/starter-project', { preHandler: superadmin }, async (req) => {
    const settings = await saveSettings(ctx.prisma, { starterProject: null });
    await audit(ctx.prisma, { ...actor(req), action: 'settings.starter_remove', ip: req.ip });
    return { settings };
  });

  app.post('/admin/settings/smtp-test', { preHandler: superadmin }, async (req) => {
    const { to } = parse(SmtpTestBodySchema, req.body);
    try {
      if (ctx.mailer.configured) await ctx.mailer.verify();
      await ctx.mailer.send(
        to,
        `${ctx.env.EVENT_NAME}: SMTP test`,
        'SMTP is configured correctly.',
      );
      return { ok: true, configured: ctx.mailer.configured };
    } catch (err) {
      throw badRequest('smtp_failed', err instanceof Error ? err.message : 'SMTP test failed');
    }
  });
}
