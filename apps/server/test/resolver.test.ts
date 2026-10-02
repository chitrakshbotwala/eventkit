import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_TARGETS } from '@eventkit/shared';
import { fetchTemurin, upstreamResolver } from '../src/services/manifest/resolver';
import { targetKey } from '../src/services/manifest/types';

const SHA = 'a'.repeat(64);

/**
 * Fake upstream APIs for the resolver. `noJdk` lists Adoptium `os/architecture` pairs
 * without a build; `vscodeDown` is a VS Code platform whose update API fails.
 */
function stubUpstream(opts: { noJdk?: string[]; vscodeDown?: string } = {}) {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input);
    switch (url.hostname) {
      case 'api.adoptium.net': {
        const key = `${url.searchParams.get('os')}/${url.searchParams.get('architecture')}`;
        if (opts.noJdk?.includes(key)) return json([]);
        const name = `jdk-${key.replace('/', '-')}.zip`;
        return json([
          {
            binary: {
              package: { link: `https://jdk.invalid/${name}`, checksum: SHA, name, size: 1 },
            },
            version: { semver: '17.0.16+8', openjdk_version: '17.0.16+8' },
          },
        ]);
      }
      case 'storage.googleapis.com': {
        const os = /releases_(\w+)\.json/.exec(url.pathname)![1];
        return json({
          base_url: 'https://storage.googleapis.com/flutter_infra_release/releases',
          current_release: { stable: 'h1' },
          releases: [
            {
              hash: 'h1',
              channel: 'stable',
              version: '3.35.4',
              release_date: '2025-09-16',
              archive: `stable/${os}/flutter_${os}_3.35.4-stable.zip`,
              sha256: SHA,
            },
          ],
        });
      }
      case 'dl.google.com': {
        const archives = ['windows', 'macosx', 'linux']
          .map(
            (o) =>
              `<archive><complete><size>1</size><url>commandlinetools-${o}-1_latest.zip</url></complete><host-os>${o}</host-os></archive>`,
          )
          .join('');
        return new Response(
          `<?xml version="1.0"?><sdk:sdk-repository xmlns:sdk="x"><remotePackage path="cmdline-tools;latest"><revision><major>19</major><minor>0</minor></revision><archives>${archives}</archives></remotePackage></sdk:sdk-repository>`,
        );
      }
      case 'update.code.visualstudio.com': {
        const platform = url.pathname.split('/')[3]!;
        if (platform === opts.vscodeDown) return new Response('down', { status: 503 });
        return json({
          url: `https://vscode.invalid/${platform}/VSCode-${platform}.zip`,
          productVersion: '1.104.0',
          sha256hash: SHA,
        });
      }
      case 'api.github.com':
        return json({
          tag_name: 'v2.51.0.windows.1',
          assets: ['64-bit', 'arm64'].map((a) => ({
            name: `Git-2.51.0-${a}.exe`,
            browser_download_url: `https://git.invalid/Git-2.51.0-${a}.exe`,
            size: 1,
            digest: `sha256:${SHA}`,
          })),
        });
      case 'raw.githubusercontent.com':
        return new Response('compileSdkVersion = 36\nndkVersion = "27.0.12077973"');
      default:
        return new Response('not stubbed', { status: 404 });
    }
  });
}

const resolve = () =>
  upstreamResolver.resolve({ dataDir: '/nonexistent', computeMissingHashes: false, log: () => {} });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('upstream resolver', () => {
  it('gives Windows on ARM the x64 JDK when Temurin has no native build', async () => {
    stubUpstream({ noJdk: ['windows/aarch64'] });
    expect((await fetchTemurin('windows', 'arm64')).fileName).toBe('jdk-windows-x64.zip');
  });

  it('does not fall back to x64 on other platforms', async () => {
    stubUpstream({ noJdk: ['mac/aarch64'] });
    await expect(fetchTemurin('macos', 'arm64')).rejects.toThrow('no Temurin 17 for macos/arm64');
  });

  it('publishes the other platforms when one fails', async () => {
    stubUpstream({ noJdk: ['windows/aarch64'], vscodeDown: 'darwin-arm64' });
    const set = await resolve();
    expect(set.targets[targetKey('macos', 'arm64')]).toBeUndefined();
    expect(Object.keys(set.targets)).toHaveLength(SUPPORTED_TARGETS.length - 1);
    expect(set.targets[targetKey('windows', 'arm64')]?.java.fileName).toBe('jdk-windows-x64.zip');
    expect(set.warnings.some((w) => w.startsWith('not published for macos/arm64:'))).toBe(true);
  });

  it('fails when no platform resolves', async () => {
    stubUpstream({
      noJdk: ['windows/x64', 'windows/aarch64', 'mac/x64', 'mac/aarch64', 'linux/x64'],
    });
    await expect(resolve()).rejects.toThrow('no platform resolved');
  });
});
