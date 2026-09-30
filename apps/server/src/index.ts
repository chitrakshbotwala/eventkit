import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { buildApp } from './app';
import { loadEnv } from './env';

async function main() {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const app = await buildApp({ env, prisma });

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.HOST, port: env.PORT });
  if (!env.MANIFEST_SIGNING_KEY)
    app.log.warn('MANIFEST_SIGNING_KEY missing: /api/manifest will fail (run pnpm keys:gen)');
  if (env.NODE_ENV !== 'production' && !app.ctx.mailer.configured) {
    app.log.warn('SMTP not configured: OTP codes are printed to this console (development only)');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
