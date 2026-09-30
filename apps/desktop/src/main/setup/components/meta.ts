import type { ComponentId, ManifestComponent, ManifestPayload } from '@eventkit/shared';

/** Share of the overall progress bar. */
export const COMPONENT_WEIGHTS: Record<ComponentId, number> = {
  system: 1,
  'linux-deps': 6,
  git: 5,
  flutter: 25,
  java: 8,
  android: 18,
  chrome: 5,
  vscode: 10,
  devtools: 2,
  warmup: 12,
  verify: 5,
};

const DEPENDS: Record<ComponentId, ComponentId[]> = {
  system: [],
  'linux-deps': ['system'],
  git: ['system', 'linux-deps'],
  flutter: ['git'],
  java: ['system'],
  android: ['java', 'flutter'],
  chrome: ['system', 'linux-deps'],
  vscode: ['system'],
  devtools: ['flutter'],
  warmup: ['flutter'],
  verify: [],
};

export function dependsOnFor(c: ManifestComponent, m: ManifestPayload): ComponentId[] {
  if (c.id === 'verify')
    return m.components.filter((x) => x.id !== 'verify' && x.enabled).map((x) => x.id);
  const deps = [...DEPENDS[c.id]];
  if (c.id === 'warmup' && c.gradleWarmup) deps.push('android');
  return deps;
}
