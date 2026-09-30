/**
 * Resolve upstream versions/hashes (Flutter, Temurin, Git, VS Code, Android, Chrome) and store
 * them for GET /api/manifest. Artifacts without published SHA-256 are downloaded into the mirror.
 * Usage: pnpm --filter @eventkit/server manifest:resolve [--no-hash]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/env';
import { upstreamResolver } from '../src/services/manifest/resolver';
import { RESOLVED_KEY } from '../src/services/manifest/types';
import { setJsonSetting } from '../src/services/settings';

async function main() {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const set = await upstreamResolver.resolve({
    dataDir: env.DATA_DIR,
    computeMissingHashes: !process.argv.includes('--no-hash'),
    githubToken: env.GITHUB_TOKEN,
    log: (m) => console.log(m),
  });
  await setJsonSetting(prisma, RESOLVED_KEY, set);
  await prisma.$disconnect();
  for (const w of set.warnings) console.warn(`warning: ${w}`);
  console.log(`resolved at ${set.resolvedAt}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
