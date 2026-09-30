export const PLATFORMS = ['windows', 'macos', 'linux'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const ARCHES = ['x64', 'arm64'] as const;
export type Arch = (typeof ARCHES)[number];

/** OS/arch combinations the setup engine supports. */
export const SUPPORTED_TARGETS: ReadonlyArray<{ os: Platform; arch: Arch }> = [
  { os: 'windows', arch: 'x64' },
  { os: 'windows', arch: 'arm64' },
  { os: 'macos', arch: 'arm64' },
  { os: 'macos', arch: 'x64' },
  { os: 'linux', arch: 'x64' },
];

export function isSupportedTarget(os: string, arch: string): boolean {
  return SUPPORTED_TARGETS.some((t) => t.os === os && t.arch === arch);
}

/** Setup components, in execution order. */
export const COMPONENT_IDS = [
  'system',
  'linux-deps',
  'git',
  'flutter',
  'java',
  'android',
  'chrome',
  'vscode',
  'devtools',
  'warmup',
  'verify',
] as const;
export type ComponentId = (typeof COMPONENT_IDS)[number];

export const COMPONENT_NAMES: Record<ComponentId, string> = {
  system: 'System check',
  'linux-deps': 'System packages',
  git: 'Git',
  flutter: 'Flutter SDK',
  java: 'Java (Temurin JDK 17)',
  android: 'Android SDK',
  chrome: 'Google Chrome',
  vscode: 'VS Code + Flutter extensions',
  devtools: 'DevTools',
  warmup: 'Offline warm-up',
  verify: 'Final verification',
};

export const QR_PREFIX = 'EK1';
export const QR_WINDOW_MS = 60_000;
/** Server accepts the current window plus/minus this many windows. */
export const QR_ACCEPT_SKEW_WINDOWS = 1;

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_PER_WINDOW = 3;
export const OTP_WINDOW_MS = 10 * 60_000;
export const OTP_COOLDOWN_MS = 30_000;

export const ATTENDEE_SESSION_TTL_MS = 30 * 24 * 3600_000;
export const ADMIN_SESSION_TTL_MS = 12 * 3600_000;

export const DEFAULT_MIN_DISK_GB = 15;
export const DEFAULT_GRACE_SECONDS = 120;
export const DEFAULT_HEARTBEAT_SECONDS = 60;
export const DEFAULT_PRESYNC_MINUTES = 5;

export const VSCODE_EXTENSIONS = ['Dart-Code.dart-code', 'Dart-Code.flutter'] as const;

export const GENESIS_HASH = '0'.repeat(64);

export const ATTENDEE_STATUSES = [
  'invited',
  'logged_in',
  'installing',
  'ready',
  'not_ready',
] as const;
export type AttendeeStatus = (typeof ATTENDEE_STATUSES)[number];

export const ADMIN_ROLES = ['superadmin', 'volunteer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];
