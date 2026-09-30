import { z } from 'zod';
import type { Arch, Platform } from '../constants';

/** Shape of storage.googleapis.com/flutter_infra_release/releases/releases_<os>.json */
export const FlutterReleasesJsonSchema = z.object({
  base_url: z.url(),
  current_release: z.record(z.string(), z.string()),
  releases: z.array(
    z.object({
      hash: z.string(),
      channel: z.string(),
      version: z.string(),
      dart_sdk_version: z.string().optional(),
      dart_sdk_arch: z.string().optional(),
      release_date: z.string(),
      archive: z.string(),
      sha256: z.string(),
    }),
  ),
});
export type FlutterReleasesJson = z.infer<typeof FlutterReleasesJsonSchema>;

export interface FlutterRelease {
  version: string;
  channel: string;
  hash: string;
  dartVersion?: string;
  arch: Arch;
  releaseDate: string;
  url: string;
  fileName: string;
  sha256: string;
  /** True when a non-native arch build was chosen (e.g. x64 SDK on Windows arm64). */
  emulated: boolean;
}

export function flutterReleasesUrl(os: Platform): string {
  return `https://storage.googleapis.com/flutter_infra_release/releases/releases_${os}.json`;
}

export class FlutterReleaseNotFoundError extends Error {
  override name = 'FlutterReleaseNotFoundError';
}

/**
 * Pick the stable Flutter release for an OS/arch.
 * - `pinnedVersion` selects that exact stable version, otherwise the current stable.
 * - Entries without `dart_sdk_arch` are x64 (older release JSON).
 * - Windows arm64 falls back to x64 when no native build exists (runs under emulation).
 */
export function selectFlutterRelease(
  json: unknown,
  os: Platform,
  arch: Arch,
  pinnedVersion?: string | null,
): FlutterRelease {
  const data = FlutterReleasesJsonSchema.parse(json);
  const stable = data.releases.filter((r) => r.channel === 'stable');

  let candidates: typeof stable;
  if (pinnedVersion) {
    candidates = stable.filter((r) => r.version === pinnedVersion);
    if (candidates.length === 0) {
      throw new FlutterReleaseNotFoundError(`Flutter ${pinnedVersion} not found on stable channel`);
    }
  } else {
    const currentHash = data.current_release['stable'];
    candidates = stable.filter((r) => r.hash === currentHash);
    if (candidates.length === 0) {
      throw new FlutterReleaseNotFoundError('current stable release not found in releases JSON');
    }
  }

  const archOf = (r: (typeof stable)[number]): string => r.dart_sdk_arch ?? 'x64';
  let chosen = candidates.find((r) => archOf(r) === arch);
  let emulated = false;
  if (!chosen && os === 'windows' && arch === 'arm64') {
    chosen = candidates.find((r) => archOf(r) === 'x64');
    emulated = Boolean(chosen);
  }
  if (!chosen) {
    throw new FlutterReleaseNotFoundError(
      `no Flutter ${candidates[0]?.version ?? ''} build for ${os}/${arch}`,
    );
  }

  const base = data.base_url.replace(/\/+$/, '');
  const fileName = chosen.archive.split('/').pop() ?? chosen.archive;
  return {
    version: chosen.version,
    channel: chosen.channel,
    hash: chosen.hash,
    dartVersion: chosen.dart_sdk_version?.split(' ')[0],
    arch: (archOf(chosen) as Arch) ?? arch,
    releaseDate: chosen.release_date,
    url: `${base}/${chosen.archive}`,
    fileName,
    sha256: chosen.sha256.toLowerCase(),
    emulated,
  };
}

/** Archive kind implied by a Flutter archive file name. */
export function flutterArchiveKind(fileName: string): 'zip' | 'tar.xz' {
  return fileName.endsWith('.tar.xz') ? 'tar.xz' : 'zip';
}
