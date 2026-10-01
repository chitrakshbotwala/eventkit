import { release } from 'node:os';
import type { ComponentOf } from '@eventkit/shared';
import { freeBytes } from '../downloader';
import { pathProblem, writable } from '../paths';
import type { ComponentRunner } from '../types';
import { COMPONENT_WEIGHTS } from './meta';
import { proxyUrlFromPac } from './util';

export interface SystemDeps {
  resolveProxy(url: string): Promise<string>;
}

/** OS/arch, disk, write access, proxy and install-path checks. Installs nothing. */
export function systemRunner(deps: SystemDeps): ComponentRunner<ComponentOf<'system'>> {
  return {
    id: 'system',
    weight: COMPONENT_WEIGHTS.system,
    dependsOn: () => [],
    artifacts: () => [],
    detect: async () => ({ installed: true }),
    install: async () => undefined,
    async verify(c, ctx) {
      const problems: string[] = [];
      const { root } = ctx.dirs;
      if (ctx.manifest.target.os !== ctx.platform || ctx.manifest.target.arch !== ctx.arch) {
        problems.push(`manifest is for ${ctx.manifest.target.os}/${ctx.manifest.target.arch}`);
      }
      if (ctx.platform === 'windows' && Number(release().split('.')[0]) < 10) {
        problems.push('Windows 10 or newer is required');
      }
      const pp = pathProblem(root);
      if (pp) problems.push(`install folder ${root} ${pp}`);
      if (!writable(root)) problems.push(`cannot write to ${root}`);

      // Full requirement before installing; afterwards only a safety margin.
      const installedAlready = Boolean(ctx.facts.flutterRoot);
      const needGb = installedAlready ? 2 : c.minDiskGb;
      const free = await freeBytes(root);
      if (free !== null && free < needGb * 1e9) {
        problems.push(`only ${(free / 1e9).toFixed(1)} GB free, ${needGb} GB needed`);
      }

      if (!ctx.quick) {
        try {
          const pac = await deps.resolveProxy('https://storage.googleapis.com/');
          const proxy = proxyUrlFromPac(pac);
          if (proxy) {
            ctx.facts.proxy = proxy;
            // Flutter, Gradle, pub and sdkmanager read these; kept in-process only.
            for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'])
              ctx.env.setSessionVar(k, proxy);
            ctx.log.info(`system proxy detected: ${proxy}`);
          } else {
            delete ctx.facts.proxy;
          }
        } catch (err) {
          ctx.log.warn(`proxy detection failed: ${String(err)}`);
        }
      }
      if (problems.length) return { ok: false, detail: problems.join('; ') };
      return {
        ok: true,
        detail: `${ctx.platform}/${ctx.arch}, ${free !== null ? `${(free / 1e9).toFixed(0)} GB free` : 'disk ok'}`,
      };
    },
  };
}
