import { which } from '../exec';
import type { ComponentContext } from '../types';
import { tryRun } from './util';

/** winget exit code for "already installed / no applicable upgrade". */
const ALREADY_INSTALLED = [-1978335189, 0x8a15002b, -1978335135];

/**
 * Install a package with winget in user scope. Returns false (so callers fall
 * back to the verified direct download) when winget is missing or fails.
 */
export async function wingetInstall(ctx: ComponentContext, id: string): Promise<boolean> {
  const winget = await which('winget');
  if (!winget) return false;
  const res = await tryRun(
    ctx,
    winget,
    [
      'install',
      '--id',
      id,
      '--exact',
      '--silent',
      '--scope',
      'user',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--disable-interactivity',
    ],
    { timeoutMs: 30 * 60_000, onLine: (l) => ctx.log.debug(`  winget: ${l}`) },
  );
  if (res && (res.code === 0 || ALREADY_INSTALLED.includes(res.code ?? 1))) {
    ctx.log.info(`winget installed ${id}`);
    return true;
  }
  ctx.log.warn(
    `winget install ${id} failed (exit ${res?.code ?? 'error'}); falling back to direct download`,
  );
  return false;
}
