import type { PrismaClient } from '@prisma/client';
import { DEFAULT_MIN_DISK_GB, SettingsSchema, type Settings } from '@eventkit/shared';

const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS: Settings = {
  pinnedFlutterVersion: null,
  mirrorBaseUrl: null,
  minDiskGb: DEFAULT_MIN_DISK_GB,
  minAppVersion: '0.1.0',
  components: { android: true, java: true, chrome: true, vscode: true, warmup: true },
  gradleWarmup: false,
  androidPlatform: 'platforms;android-36',
  androidBuildTools: 'build-tools;36.0.0',
  androidNdk: null,
  starterProject: null,
};

export async function getSettings(prisma: PrismaClient): Promise<Settings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return structuredClone(DEFAULT_SETTINGS);
  const merged = { ...DEFAULT_SETTINGS, ...safeJson(row.value) };
  merged.components = { ...DEFAULT_SETTINGS.components, ...(merged.components ?? {}) };
  const parsed = SettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
}

export async function saveSettings(
  prisma: PrismaClient,
  patch: Partial<Settings>,
): Promise<Settings> {
  const current = await getSettings(prisma);
  const next = SettingsSchema.parse({
    ...current,
    ...patch,
    components: { ...current.components, ...(patch.components ?? {}) },
  });
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  return next;
}

/** Generic JSON key/value helpers for other stored documents (resolved manifests, etc). */
export async function getJsonSetting<T>(prisma: PrismaClient, key: string): Promise<T | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row ? (safeJson(row.value) as T) : null;
}

export async function setJsonSetting(prisma: PrismaClient, key: string, value: unknown) {
  const v = JSON.stringify(value);
  await prisma.setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
}

function safeJson(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
