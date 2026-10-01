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
  if (app.ctx.identity.kind === 'dev') {
    app.log.warn(
      'GOOGLE_CLIENT_ID not set: attendees sign in on a development page that accepts any email',
    );
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
