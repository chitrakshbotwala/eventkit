import {
  canonicalJson,
  COMPONENT_NAMES,
  flutterArchiveKind,
  selectFlutterRelease,
  VSCODE_EXTENSIONS,
  type Arch,
  type Artifact,
  type ManifestComponent,
  type ManifestPayload,
  type Platform,
  type Settings,
} from '@eventkit/shared';
import { sha256Hex } from '@eventkit/shared/node';
import type { ResolvedArtifact, ResolvedSet } from './types';
import { targetKey } from './types';

export const LINUX_PACKAGES = {
  apt: [
    'curl',
    'git',
    'unzip',
    'xz-utils',
    'zip',
    'libglu1-mesa',
    'clang',
    'cmake',
    'ninja-build',
    'pkg-config',
    'libgtk-3-dev',
    'liblzma-dev',
  ],
  dnf: [
    'curl',
    'git',
    'unzip',
    'xz',
    'zip',
    'mesa-libGLU',
    'clang',
    'cmake',
    'ninja-build',
    'pkgconf-pkg-config',
    'gtk3-devel',
    'xz-devel',
  ],
  pacman: [
    'curl',
    'git',
    'unzip',
    'xz',
    'zip',
    'glu',
    'clang',
    'cmake',
    'ninja',
    'pkgconf',
    'gtk3',
  ],
  zypper: [
    'curl',
    'git',
    'unzip',
    'xz',
    'zip',
    'libGLU1',
    'clang',
    'cmake',
    'ninja',
    'pkg-config',
    'gtk3-devel',
    'xz-devel',
  ],
};

const GIT_ARGS = [
  '/VERYSILENT',
  '/NORESTART',
  '/NOCANCEL',
  '/SP-',
  '/SUPPRESSMSGBOXES',
  '/CURRENTUSER',
  '/o:PathOption=Cmd',
];
const VSCODE_WIN_ARGS = ['/VERYSILENT', '/NORESTART', '/MERGETASKS=!runcode,addtopath'];
const CHROME_WIN_ARGS = ['/silent', '/install'];

export interface BuildInput {
  os: Platform;
  arch: Arch;
  settings: Settings;
  resolved: ResolvedSet;
  placeholder: boolean;
  event: { slug: string; name: string };
  publicBaseUrl: string;
  now: number;
  ttlHours: number;
}

function art(component: string, r: ResolvedArtifact, installArgs: string[] = []): Artifact {
  return {
    url: r.url,
    mirrorPath: `${component}/${r.version}/${r.fileName}`,
    sha256: r.sha256,
    size: r.size,
    fileName: r.fileName,
    kind: r.kind,
    installArgs,
    ...(r.hashFromMirror ? { hashFromMirror: true } : {}),
  };
}

export class ManifestBuildError extends Error {
  override name = 'ManifestBuildError';
}

/** Assemble the (unsigned) manifest for one OS/arch from resolved upstream data + admin settings. */
export function buildManifestPayload(input: BuildInput): ManifestPayload {
  const { os, arch, settings, resolved } = input;
  const target = resolved.targets[targetKey(os, arch)];
  const releases = resolved.flutterReleases[os];
  if (!target || !releases) throw new ManifestBuildError(`no resolved artifacts for ${os}/${arch}`);

  const flutterRelease = selectFlutterRelease(releases, os, arch, settings.pinnedFlutterVersion);
  const t = settings.components;
  const name = (id: ManifestComponent['id']) => COMPONENT_NAMES[id];

  const components: ManifestComponent[] = [
    {
      id: 'system',
      name: name('system'),
      enabled: true,
      required: true,
      minDiskGb: settings.minDiskGb,
    },
  ];
  if (os === 'linux') {
    components.push({
      id: 'linux-deps',
      name: name('linux-deps'),
      enabled: true,
      required: true,
      packages: LINUX_PACKAGES,
    });
  }
  components.push({
    id: 'git',
    name: name('git'),
    enabled: true,
    required: true,
    minVersion: '2.30.0',
    ...(target.git
      ? {
          version: target.git.version,
          artifact: art('git', target.git, GIT_ARGS),
          wingetId: 'Git.Git',
        }
      : {}),
  });
  components.push({
    id: 'flutter',
    name: name('flutter'),
    enabled: true,
    required: true,
    channel: 'stable',
    version: flutterRelease.version,
    dartVersion: flutterRelease.dartVersion,
    pinned: Boolean(settings.pinnedFlutterVersion),
    artifact: art('flutter', {
      url: flutterRelease.url,
      sha256: flutterRelease.sha256,
      fileName: flutterRelease.fileName,
      kind: flutterArchiveKind(flutterRelease.fileName),
      version: flutterRelease.version,
    }),
  });
  components.push({
    id: 'java',
    name: name('java'),
    enabled: t.java,
    required: t.java,
    majorVersion: 17,
    version: target.java.version,
    artifact: art('java', target.java),
  });
  const androidPackages = ['platform-tools', settings.androidPlatform, settings.androidBuildTools];
  if (settings.androidNdk) androidPackages.push(settings.androidNdk);
  components.push({
    id: 'android',
    name: name('android'),
    enabled: t.android,
    required: t.android,
    cmdlineTools: art('android', target.androidCmdlineTools),
    packages: androidPackages,
    acceptLicenses: true,
  });
  components.push({
    id: 'chrome',
    name: name('chrome'),
    enabled: t.chrome,
    required: t.chrome,
    ...(target.chrome
      ? { artifact: art('chrome', target.chrome, os === 'windows' ? CHROME_WIN_ARGS : []) }
      : {}),
    ...(target.chromeDeb && target.chromeRpm
      ? {
          linuxPackages: {
            deb: art('chrome', target.chromeDeb),
            rpm: art('chrome', target.chromeRpm),
          },
        }
      : {}),
    ...(os === 'windows' ? { wingetId: 'Google.Chrome' } : {}),
  });
  components.push({
    id: 'vscode',
    name: name('vscode'),
    enabled: t.vscode,
    required: t.vscode,
    version: target.vscode.version,
    artifact: art('vscode', target.vscode, os === 'windows' ? VSCODE_WIN_ARGS : []),
    extensions: [...VSCODE_EXTENSIONS],
    ...(os === 'windows' ? { wingetId: 'Microsoft.VisualStudioCode' } : {}),
  });
  components.push({ id: 'devtools', name: name('devtools'), enabled: true, required: true });
  const starter = settings.starterProject;
  components.push({
    id: 'warmup',
    name: name('warmup'),
    enabled: t.warmup,
    required: t.warmup,
    starter: starter
      ? {
          url: `${input.publicBaseUrl.replace(/\/+$/, '')}/api/starter-project/${starter.sha256}.zip`,
          sha256: starter.sha256,
          size: starter.size,
          fileName: `${starter.projectName}.zip`,
          projectName: starter.projectName,
        }
      : null,
    gradleWarmup: settings.gradleWarmup && t.android,
  });
  components.push({ id: 'verify', name: name('verify'), enabled: true, required: true });

  const body = {
    event: input.event,
    target: { os, arch },
    mirrorBaseUrl: settings.mirrorBaseUrl,
    minAppVersion: settings.minAppVersion,
    placeholder: input.placeholder,
    components,
  };
  const manifestId = sha256Hex(canonicalJson(body)).slice(0, 16);
  return {
    schemaVersion: 1,
    manifestId,
    issuedAt: new Date(input.now).toISOString(),
    expiresAt: new Date(input.now + input.ttlHours * 3600_000).toISOString(),
    ...body,
  };
}
