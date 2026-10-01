import type { Arch, ManifestPayload, Platform, SignedManifest } from '@eventkit/shared';
import { signManifest } from '@eventkit/shared/node';
import type { AppContext } from '../../context';
import { unavailable } from '../../lib/errors';
import { getJsonSetting, getSettings, saveSettings, setJsonSetting } from '../settings';
import { buildManifestPayload, ManifestBuildError } from './builder';
import { placeholderResolvedSet } from './placeholder';
import { RESOLVE_STATUS_KEY, RESOLVED_KEY, type ResolvedSet, type ResolveStatus } from './types';
import { DEFAULT_SETTINGS } from '../settings';

async function loadResolved(ctx: AppContext): Promise<{ set: ResolvedSet; placeholder: boolean }> {
  const set = await getJsonSetting<ResolvedSet>(ctx.prisma, RESOLVED_KEY);
  if (set) return { set, placeholder: false };
  if (ctx.env.MANIFEST_ALLOW_PLACEHOLDER)
    return { set: placeholderResolvedSet(), placeholder: true };
  throw unavailable(
    'manifest_not_ready',
    'The organizers have not published the setup manifest yet.',
  );
}

/** Unsigned manifest payload for one target (also used by readiness validation). */
export async function manifestPayloadFor(
  ctx: AppContext,
  os: Platform,
  arch: Arch,
): Promise<ManifestPayload> {
  const [{ set, placeholder }, settings, event] = await Promise.all([
    loadResolved(ctx),
    getSettings(ctx.prisma),
    ctx.event(),
  ]);
  try {
    return buildManifestPayload({
      os,
      arch,
      settings,
      resolved: set,
      placeholder,
      event: { slug: event.slug, name: event.name },
      publicBaseUrl: ctx.env.PUBLIC_BASE_URL,
      now: ctx.now(),
      ttlHours: ctx.env.MANIFEST_TTL_HOURS,
    });
  } catch (err) {
    if (
      err instanceof ManifestBuildError ||
      (err instanceof Error && err.name === 'FlutterReleaseNotFoundError')
    ) {
      throw unavailable('manifest_not_ready', err.message);
    }
    throw err;
  }
}

export async function signedManifestFor(
  ctx: AppContext,
  os: Platform,
  arch: Arch,
): Promise<SignedManifest> {
  const key = ctx.env.MANIFEST_SIGNING_KEY;
  if (!key)
    throw unavailable(
      'manifest_unsigned',
      'MANIFEST_SIGNING_KEY is not configured (run pnpm keys:gen)',
    );
  const payload = await manifestPayloadFor(ctx, os, arch);
  for (const c of payload.components) {
    const arts = [
      'artifact' in c ? c.artifact : undefined,
      c.id === 'android' ? c.cmdlineTools : undefined,
      ...(c.id === 'chrome' && c.linuxPackages ? [c.linuxPackages.deb, c.linuxPackages.rpm] : []),
    ];
    if (arts.some((a) => a && !/^[a-f0-9]{64}$/.test(a.sha256))) {
      throw unavailable(
        'manifest_incomplete',
        `artifact hash missing for ${c.id}; re-run manifest resolve`,
      );
    }
  }
  return signManifest(payload, key);
}

// ---------- background resolve job ----------

let running: Promise<void> | null = null;

export async function getResolveStatus(
  ctx: AppContext,
): Promise<ResolveStatus & { resolvedAt: string | null }> {
  const status = (await getJsonSetting<ResolveStatus>(ctx.prisma, RESOLVE_STATUS_KEY)) ?? {
    state: 'idle',
    log: [],
  };
  const set = await getJsonSetting<ResolvedSet>(ctx.prisma, RESOLVED_KEY);
  return { ...status, resolvedAt: set?.resolvedAt ?? null };
}

/** Start resolving upstream metadata in the background (single-flight). */
export function startResolve(
  ctx: AppContext,
  opts: { computeMissingHashes?: boolean } = {},
): Promise<void> {
  if (running) return running;
  const status: ResolveStatus = { state: 'running', startedAt: new Date().toISOString(), log: [] };
  const save = () => setJsonSetting(ctx.prisma, RESOLVE_STATUS_KEY, status).catch(() => undefined);
  const log = (m: string) => {
    status.log.push(`${new Date().toISOString()} ${m}`);
    if (status.log.length > 300) status.log.shift();
    void save();
  };
  running = (async () => {
    await save();
    try {
      const set = await ctx.resolver.resolve({
        dataDir: ctx.env.DATA_DIR,
        computeMissingHashes: opts.computeMissingHashes ?? true,
        githubToken: ctx.env.GITHUB_TOKEN,
        log,
      });
      await setJsonSetting(ctx.prisma, RESOLVED_KEY, set);
      // Adopt Flutter's template Android versions while the admin has not overridden them.
      const settings = await getSettings(ctx.prisma);
      if (
        set.android?.compileSdk &&
        settings.androidPlatform === DEFAULT_SETTINGS.androidPlatform
      ) {
        await saveSettings(ctx.prisma, {
          androidPlatform: `platforms;android-${set.android.compileSdk}`,
          androidBuildTools:
            settings.androidBuildTools === DEFAULT_SETTINGS.androidBuildTools
              ? `build-tools;${set.android.compileSdk}.0.0`
              : settings.androidBuildTools,
        });
      }
      for (const w of set.warnings) log(`warning: ${w}`);
      status.state = 'done';
      status.message = `resolved at ${set.resolvedAt}`;
    } catch (err) {
      status.state = 'failed';
      status.message = err instanceof Error ? err.message : String(err);
      log(`failed: ${status.message}`);
    } finally {
      status.finishedAt = new Date().toISOString();
      await save();
      running = null;
    }
  })();
  return running;
}
