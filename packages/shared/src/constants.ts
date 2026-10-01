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

/** How long an attendee has to finish Google sign-in in the browser. */
export const SIGNIN_REQUEST_TTL_MS = 10 * 60_000;
/** Lifetime of the one-time code the desktop app redeems for a session. */
export const SIGNIN_CODE_TTL_MS = 2 * 60_000;

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
