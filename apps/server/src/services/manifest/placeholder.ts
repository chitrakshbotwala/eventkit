import { SUPPORTED_TARGETS, type Arch, type Platform } from '@eventkit/shared';
import { sha256Hex } from '@eventkit/shared/node';
import type { ResolvedArtifact, ResolvedSet, ResolvedTarget } from './types';
import { targetKey } from './types';

/**
 * Placeholder artifacts for development before `manifest:resolve` has run.
 * They point at an unroutable host; only `--simulate` clients can "install" them,
 * and real clients refuse manifests with `placeholder: true`.
 */
const FAKE_SHA = sha256Hex('eventkit-placeholder');
const FLUTTER_VERSION = '3.35.4';

function fake(fileName: string, kind: ResolvedArtifact['kind'], version: string): ResolvedArtifact {
  return {
    url: `https://placeholder.invalid/${fileName}`,
    sha256: FAKE_SHA,
    fileName,
    kind,
    version,
    size: 1024,
  };
}

function flutterJson(os: Platform) {
  const archs: Arch[] = os === 'macos' ? ['x64', 'arm64'] : ['x64'];
  const ext = os === 'linux' ? 'tar.xz' : 'zip';
  return {
    base_url: 'https://placeholder.invalid/flutter',
    current_release: { stable: 'placeholder-hash' },
    releases: archs.map((arch) => ({
      hash: 'placeholder-hash',
      channel: 'stable',
      version: FLUTTER_VERSION,
      dart_sdk_version: '3.9.2',
      dart_sdk_arch: arch,
      release_date: '2025-09-16T00:00:00.000Z',
      archive: `stable/${os}/flutter_${os}${arch === 'arm64' ? '_arm64' : ''}_${FLUTTER_VERSION}-stable.${ext}`,
      sha256: FAKE_SHA,
    })),
  };
}

export function placeholderResolvedSet(): ResolvedSet {
  const targets: Record<string, ResolvedTarget> = {};
  for (const { os, arch } of SUPPORTED_TARGETS) {
    const t: ResolvedTarget = {
      os,
      arch,
      java: fake(
        `jdk-17-${os}-${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`,
        os === 'windows' ? 'zip' : 'tar.gz',
        '17.0.16+8',
      ),
      androidCmdlineTools: fake(`commandlinetools-${os}_latest.zip`, 'zip', '19.0'),
      vscode: fake(
        `vscode-${os}-${arch}.${os === 'windows' ? 'exe' : os === 'macos' ? 'zip' : 'tar.gz'}`,
        os === 'windows' ? 'exe' : os === 'macos' ? 'zip' : 'tar.gz',
        '1.104.2',
      ),
    };
    if (os === 'windows') {
      t.git = fake(`Git-2.51.0-${arch === 'arm64' ? 'arm64' : '64-bit'}.exe`, 'exe', '2.51.0');
      t.chrome = fake('ChromeStandaloneSetup64.exe', 'exe', 'stable');
    }
    if (os === 'macos') t.chrome = fake('googlechrome.dmg', 'dmg', 'stable');
    if (os === 'linux') {
      t.chromeDeb = fake('google-chrome-stable_current_amd64.deb', 'deb', 'stable');
      t.chromeRpm = fake('google-chrome-stable_current_x86_64.rpm', 'rpm', 'stable');
    }
    targets[targetKey(os, arch)] = t;
  }
  return {
    resolvedAt: new Date(0).toISOString(),
    flutterReleases: {
      windows: flutterJson('windows'),
      macos: flutterJson('macos'),
      linux: flutterJson('linux'),
    },
    targets,
    warnings: ['placeholder manifest: only usable in --simulate mode'],
  };
}
