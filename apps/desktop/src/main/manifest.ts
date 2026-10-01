import { SignedManifestSchema, type ManifestPayload } from '@eventkit/shared';
import { ManifestVerificationError, verifySignedManifest } from '@eventkit/shared/node';
import { api, ApiError } from './api';
import { config, paths } from './config';
import { currentArch, currentPlatform } from './device';
import { logger } from './logger';
import type { ManifestSource } from './setup/engine';
import { readJson, writeJson } from './store';

const log = logger.scope('manifest');
const CACHE = () => paths.file('manifest.json');

/**
 * Fetches the signed manifest and verifies its Ed25519 signature against the
 * keys embedded at build time. This app runs installers, so an unsigned or
 * tampered manifest is always refused. The last good envelope is cached (still
 * signed) so re-verification works offline.
 */
export const manifestSource: ManifestSource = {
  async load({ allowCached }) {
    if (config.manifestPublicKeys.length === 0) {
      throw new ManifestVerificationError(
        'No manifest signing key is embedded in this build (run pnpm keys:gen).',
      );
    }
    const expect = { os: currentPlatform(), arch: currentArch() };
    try {
      const envelope = await api.request(
        `/api/manifest?os=${expect.os}&arch=${expect.arch}`,
        SignedManifestSchema,
        {
          timeoutMs: 20_000,
        },
      );
      const manifest = verifySignedManifest(envelope, config.manifestPublicKeys, { expect });
      writeJson(CACHE(), envelope);
      return { manifest, fromCache: false };
    } catch (err) {
      if (err instanceof ManifestVerificationError) {
        log.error(`manifest rejected: ${err.message}`);
        throw new ManifestVerificationError(
          `The setup manifest failed its security check (${err.message}). Setup stopped.`,
        );
      }
      const offline = err instanceof ApiError && (err.offline || err.status >= 500);
      if (!allowCached || !offline) throw err;
      const cached = readJson<unknown>(CACHE(), null);
      if (!cached) throw err;
      // Signature is re-checked; expiry is ignored for offline re-verification only.
      const manifest: ManifestPayload = verifySignedManifest(cached, config.manifestPublicKeys, {
        expect,
        now: 0,
      });
      return { manifest, fromCache: true };
    }
  },
};
