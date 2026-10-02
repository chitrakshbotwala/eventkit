import { XMLParser } from 'fast-xml-parser';
import {
  FlutterReleasesJsonSchema,
  flutterReleasesUrl,
  PLATFORMS,
  SUPPORTED_TARGETS,
  type Arch,
  type FlutterReleasesJson,
  type Platform,
} from '@eventkit/shared';
import { ensureMirrored } from '../mirror';
import type { ResolvedArtifact, ResolvedSet, ResolvedTarget } from './types';
import { targetKey } from './types';

export interface ResolveOptions {
  dataDir: string;
  /** Download artifacts without published SHA-256 into the mirror to hash them. */
  computeMissingHashes: boolean;
  /** Also mirror artifacts that DO publish hashes (full LAN mirror). */
  mirrorAll?: boolean;
  githubToken?: string;
  log: (msg: string) => void;
}

export interface ManifestResolver {
  resolve(opts: ResolveOptions): Promise<ResolvedSet>;
}

const UA = { 'user-agent': 'eventkit-manifest-resolver' };

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers: { ...UA, accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

// ---------- Flutter ----------

export async function fetchFlutterReleases(os: Platform): Promise<FlutterReleasesJson> {
  const json = FlutterReleasesJsonSchema.parse(await getJson(flutterReleasesUrl(os)));
  return { ...json, releases: json.releases.filter((r) => r.channel === 'stable') };
}

/** compileSdk / ndkVersion used by Flutter's app template at a given version. */
export async function fetchFlutterAndroidDefaults(version: string) {
  const base = `https://raw.githubusercontent.com/flutter/flutter/${version}/packages/flutter_tools/gradle/src/main`;
  for (const path of ['kotlin/FlutterExtension.kt', 'groovy/flutter.groovy']) {
    try {
      const src = await getText(`${base}/${path}`);
      const sdk = /compileSdkVersion\s*(?::\s*Int\s*)?=\s*(\d+)/.exec(src)?.[1];
      const ndk = /ndkVersion\s*(?::\s*String\s*)?=\s*"([\d.]+)"/.exec(src)?.[1];
      if (sdk) return { compileSdk: Number(sdk), ndkVersion: ndk, flutterVersion: version };
    } catch {
      // try next location
    }
  }
  return undefined;
}

// ---------- Temurin (Adoptium API) ----------

interface AdoptiumAsset {
  binary: { package: { link: string; checksum: string; name: string; size: number } };
  version: { semver: string; openjdk_version: string };
}

async function temurinAssets(os: Platform, arch: Arch): Promise<AdoptiumAsset[]> {
  const aos = os === 'macos' ? 'mac' : os;
  const aarch = arch === 'arm64' ? 'aarch64' : 'x64';
  const url = `https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=${aarch}&image_type=jdk&os=${aos}&vendor=eclipse`;
  return (await getJson(url)) as AdoptiumAsset[];
}

/**
 * Temurin JDK 17 for an OS/arch. There is no Windows arm64 build of 17, so Windows on
 * ARM gets the x64 JDK, which runs under emulation (same as Flutter there).
 */
export async function fetchTemurin(os: Platform, arch: Arch): Promise<ResolvedArtifact> {
  let a = (await temurinAssets(os, arch))[0];
  if (!a && os === 'windows' && arch === 'arm64') a = (await temurinAssets(os, 'x64'))[0];
  if (!a) throw new Error(`no Temurin 17 for ${os}/${arch}`);
  const p = a.binary.package;
  return {
    url: p.link,
    sha256: p.checksum.toLowerCase(),
    size: p.size,
    fileName: p.name,
    kind: p.name.endsWith('.zip') ? 'zip' : 'tar.gz',
    version: a.version.openjdk_version,
  };
}

// ---------- Git for Windows (GitHub API) ----------

interface GhRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
    digest?: string | null;
  }>;
}

export async function fetchGitForWindows(
  arch: Arch,
  token?: string,
): Promise<ResolvedArtifact & { needsHash: boolean }> {
  const rel = (await getJson(
    'https://api.github.com/repos/git-for-windows/git/releases/latest',
    token ? { authorization: `Bearer ${token}` } : {},
  )) as GhRelease;
  const version = /v?(\d+\.\d+\.\d+)/.exec(rel.tag_name)?.[1] ?? rel.tag_name;
  const re = arch === 'arm64' ? /^Git-[\d.]+-arm64\.exe$/ : /^Git-[\d.]+-64-bit\.exe$/;
  const asset = rel.assets.find((a) => re.test(a.name));
  if (!asset) throw new Error(`no Git for Windows installer for ${arch} in ${rel.tag_name}`);
  const digest = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7).toLowerCase() : '';
  return {
    url: asset.browser_download_url,
    sha256: digest,
    size: asset.size,
    fileName: asset.name,
    kind: 'exe',
    version,
    needsHash: !digest,
  };
}

// ---------- VS Code (update API) ----------

export async function fetchVsCode(os: Platform, arch: Arch): Promise<ResolvedArtifact> {
  const platform =
    os === 'windows'
      ? `win32-${arch}-user`
      : os === 'macos'
        ? arch === 'arm64'
          ? 'darwin-arm64'
          : 'darwin'
        : 'linux-x64';
  const info = (await getJson(
    `https://update.code.visualstudio.com/api/update/${platform}/stable/latest`,
  )) as {
    url: string;
    productVersion: string;
    sha256hash: string;
  };
  const fileName = decodeURIComponent(
    new URL(info.url).pathname.split('/').pop() ?? `vscode-${platform}`,
  );
  const kind = fileName.endsWith('.exe') ? 'exe' : fileName.endsWith('.zip') ? 'zip' : 'tar.gz';
  return {
    url: info.url,
    sha256: info.sha256hash.toLowerCase(),
    fileName,
    kind,
    version: info.productVersion,
  };
}

// ---------- Android cmdline-tools (repository XML) ----------

export async function fetchAndroidCmdlineTools(): Promise<
  Record<Platform, Omit<ResolvedArtifact, 'sha256'>>
> {
  const base = 'https://dl.google.com/android/repository/';
  const xml = await getText(`${base}repository2-3.xml`);
  const doc = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' }).parse(
    xml,
  ) as Record<string, unknown>;
  const root = (doc['sdk:sdk-repository'] ??
    doc['ns2:sdk-repository'] ??
    Object.values(doc).find((v) => typeof v === 'object')) as {
    remotePackage: Array<Record<string, unknown>>;
  };
  const pkgs = Array.isArray(root.remotePackage) ? root.remotePackage : [root.remotePackage];
  const pkg = pkgs.find((p) => p['@path'] === 'cmdline-tools;latest');
  if (!pkg) throw new Error('cmdline-tools;latest not found in repository XML');
  const rev = pkg['revision'] as { major?: number; minor?: number };
  const version = `${rev.major ?? 0}.${rev.minor ?? 0}`;
  const archivesNode = (pkg['archives'] as { archive: unknown }).archive;
  const archives = (Array.isArray(archivesNode) ? archivesNode : [archivesNode]) as Array<{
    complete: { size: number; url: string };
    'host-os'?: string;
  }>;
  const out: Partial<Record<Platform, Omit<ResolvedArtifact, 'sha256'>>> = {};
  const hostMap: Record<string, Platform> = { windows: 'windows', macosx: 'macos', linux: 'linux' };
  for (const a of archives) {
    const os = hostMap[a['host-os'] ?? ''];
    if (!os) continue;
    out[os] = {
      url: base + a.complete.url,
      size: Number(a.complete.size),
      fileName: a.complete.url,
      kind: 'zip',
      version,
    };
  }
  for (const os of PLATFORMS) if (!out[os]) throw new Error(`cmdline-tools missing for ${os}`);
  return out as Record<Platform, Omit<ResolvedArtifact, 'sha256'>>;
}

// ---------- Chrome (no published hashes) ----------

export function chromeSources(
  os: Platform,
  arch: Arch,
): Array<{
  key: 'chrome' | 'chromeDeb' | 'chromeRpm';
  url: string;
  fileName: string;
  kind: ResolvedArtifact['kind'];
}> {
  if (os === 'windows') {
    const ap = arch === 'arm64' ? 'arm64-stable-statsdef_1' : 'x64-stable-statsdef_1';
    const tag = encodeURIComponent(
      `appguid={8A69D345-D564-463C-AFF1-A69D9E530F96}&iid={00000000-0000-0000-0000-000000000000}&lang=en&browser=4&usagestats=0&appname=Google%20Chrome&needsadmin=false&ap=${ap}&installdataindex=empty`,
    );
    return [
      {
        key: 'chrome',
        url: `https://dl.google.com/tag/s/${tag}/chrome/install/ChromeStandaloneSetup64.exe`,
        fileName:
          arch === 'arm64' ? 'ChromeStandaloneSetupArm64.exe' : 'ChromeStandaloneSetup64.exe',
        kind: 'exe',
      },
    ];
  }
  if (os === 'macos') {
    return [
      {
        key: 'chrome',
        url: 'https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg',
        fileName: 'googlechrome.dmg',
        kind: 'dmg',
      },
    ];
  }
  return [
    {
      key: 'chromeDeb',
      url: 'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb',
      fileName: 'google-chrome-stable_current_amd64.deb',
      kind: 'deb',
    },
    {
      key: 'chromeRpm',
      url: 'https://dl.google.com/linux/direct/google-chrome-stable_current_x86_64.rpm',
      fileName: 'google-chrome-stable_current_x86_64.rpm',
      kind: 'rpm',
    },
  ];
}

/** Stamp used as "version" for mutable Chrome URLs so mirror paths change daily. */
const dayStamp = () => new Date().toISOString().slice(0, 10);

/** Default resolver hitting the real upstream sources. */
export const upstreamResolver: ManifestResolver = {
  async resolve(opts) {
    const { log } = opts;
    const warnings: string[] = [];
    const flutterReleases: ResolvedSet['flutterReleases'] = {};
    for (const os of PLATFORMS) {
      log(`flutter: fetching releases_${os}.json`);
      flutterReleases[os] = await fetchFlutterReleases(os);
    }
    log('android: reading repository2-3.xml');
    const cmdline = await fetchAndroidCmdlineTools();

    const mirrorHash = async (
      component: string,
      a: Omit<ResolvedArtifact, 'sha256'>,
      expected?: string,
    ) => {
      const rel = `${component}/${a.version}/${a.fileName}`;
      const r = await ensureMirrored(opts.dataDir, a.url, rel, { expectedSha256: expected, log });
      return r;
    };

    const resolveTarget = async (os: Platform, arch: Arch): Promise<ResolvedTarget> => {
      const java = await fetchTemurin(os, arch);
      const vscode = await fetchVsCode(os, arch);
      const cl = cmdline[os];
      let clSha = '';
      if (opts.computeMissingHashes) clSha = (await mirrorHash('android', cl)).sha256;
      else warnings.push(`android cmdline-tools for ${os}: hash not computed`);
      const t: ResolvedTarget = {
        os,
        arch,
        java,
        vscode,
        androidCmdlineTools: { ...cl, sha256: clSha, hashFromMirror: true },
      };
      if (os === 'windows') {
        const git = await fetchGitForWindows(arch, opts.githubToken);
        if (git.needsHash) {
          if (opts.computeMissingHashes) git.sha256 = (await mirrorHash('git', git)).sha256;
          else warnings.push(`git for ${arch}: hash not published and not computed`);
        }
        const { needsHash, ...rest } = git;
        t.git = { ...rest, ...(needsHash ? { hashFromMirror: true } : {}) };
      }
      for (const src of chromeSources(os, arch)) {
        const a = { url: src.url, fileName: src.fileName, kind: src.kind, version: dayStamp() };
        if (!opts.computeMissingHashes) {
          warnings.push(`chrome ${src.fileName}: hash not computed`);
          continue;
        }
        const r = await mirrorHash('chrome', a);
        t[src.key] = { ...a, sha256: r.sha256, size: r.size, hashFromMirror: true };
      }
      if (opts.mirrorAll) {
        await mirrorHash('java', java, java.sha256);
        await mirrorHash('vscode', vscode, vscode.sha256);
      }
      return t;
    };

    // One platform failing (an upstream outage, a build that doesn't exist) must not block
    // the others. Its attendees see "not published yet" until a later resolve succeeds.
    const targets: Record<string, ResolvedTarget> = {};
    const failed: string[] = [];
    for (const { os, arch } of SUPPORTED_TARGETS) {
      log(`target ${os}/${arch}`);
      try {
        targets[targetKey(os, arch)] = await resolveTarget(os, arch);
      } catch (err) {
        const msg = `${os}/${arch}: ${err instanceof Error ? err.message : String(err)}`;
        log(`skipped ${msg}`);
        failed.push(msg);
      }
    }
    if (failed.length === SUPPORTED_TARGETS.length) {
      throw new Error(`no platform resolved (${failed.join('; ')})`);
    }
    for (const f of failed) warnings.push(`not published for ${f}`);

    let android: ResolvedSet['android'];
    const current = flutterReleases.linux?.releases.find(
      (r) => r.hash === flutterReleases.linux?.current_release['stable'],
    );
    if (current) {
      android = await fetchFlutterAndroidDefaults(current.version);
      if (!android) warnings.push('could not read Android defaults from the Flutter repo');
    }
    const invalid = Object.values(targets).some((t) => !t.androidCmdlineTools.sha256);
    if (invalid)
      warnings.push('some artifacts have no sha256; manifest cannot be served until computed');
    return { resolvedAt: new Date().toISOString(), flutterReleases, targets, android, warnings };
  },
};
