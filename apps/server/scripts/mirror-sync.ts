/**
 * Download every artifact referenced by the current manifests (all OS/arch targets) into
 * DATA_DIR/mirror, verifying SHA-256. Serve that directory (this server's /mirror/ or nginx)
 * and set "Mirror URL" in admin settings so clients download from the LAN.
 * Usage: pnpm --filter @eventkit/server mirror:sync
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { SUPPORTED_TARGETS, type Artifact } from '@eventkit/shared';
import { loadEnv } from '../src/env';
import { currentEvent } from '../src/services/event';
import { Hub } from '../src/services/hub';
import { upstreamResolver } from '../src/services/manifest/resolver';
import { manifestPayloadFor } from '../src/services/manifest/service';
import { ensureMirrored } from '../src/services/mirror';
import type { AppContext } from '../src/context';
import { devProvider } from '../src/services/google';

async function main() {
  const env = loadEnv();
  const prisma = new PrismaClient();
  const ctx: AppContext = {
    env: { ...env, MANIFEST_ALLOW_PLACEHOLDER: false },
    prisma,
    hub: new Hub(),
    resolver: upstreamResolver,
    now: Date.now,
    event: () => currentEvent(prisma, env),
    identity: devProvider(),
    log: console,
  };
  const seen = new Set<string>();
  for (const { os, arch } of SUPPORTED_TARGETS) {
    const m = await manifestPayloadFor(ctx, os, arch);
    const arts: Artifact[] = [];
    for (const c of m.components) {
      if ('artifact' in c && c.artifact) arts.push(c.artifact);
      if (c.id === 'android') arts.push(c.cmdlineTools);
      if (c.id === 'chrome' && c.linuxPackages) arts.push(c.linuxPackages.deb, c.linuxPackages.rpm);
    }
    for (const a of arts) {
      if (!a.mirrorPath || seen.has(a.mirrorPath)) continue;
      seen.add(a.mirrorPath);
      const r = await ensureMirrored(env.DATA_DIR, a.url, a.mirrorPath, {
        expectedSha256: a.sha256,
        log: (msg) => console.log(msg),
      });
      console.log(`ok ${a.mirrorPath} (${(r.size / 1e6).toFixed(1)} MB)`);
    }
  }
  await prisma.$disconnect();
  console.log(`${seen.size} artifacts mirrored under ${env.DATA_DIR}/mirror`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
