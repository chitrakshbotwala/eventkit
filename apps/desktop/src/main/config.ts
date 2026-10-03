import { app } from 'electron';
import { join } from 'node:path';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const packaged = app.isPackaged;

/**
 * Simulate mode fakes every install so the UI and state machine can be exercised
 * on a dev machine. It is only available in unpackaged (development) builds.
 */
const simulate =
  !packaged && (process.argv.includes('--simulate') || process.env['EVENTKIT_SIMULATE'] === '1');

function resolveApiBase(): string {
  const override = !packaged ? (argValue('server') ?? process.env['EVENTKIT_SERVER']) : undefined;
  const url = (
    override ??
    import.meta.env.MAIN_VITE_API_BASE_URL ??
    'http://localhost:8080'
  ).replace(/\/+$/, '');
  const parsed = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (packaged && parsed.protocol !== 'https:' && !local) {
    throw new Error(`Refusing insecure API base URL in a packaged build: ${url}`);
  }
  return url;
}

export const config = {
  packaged,
  simulate,
  apiBaseUrl: resolveApiBase(),
  /** Trusted Ed25519 manifest keys, embedded at build time. */
  manifestPublicKeys: (import.meta.env.MAIN_VITE_MANIFEST_PUBKEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  /** Simulated failure injection, e.g. --simulate-fail=flutter:download,android:install */
  simulateFailures: (argValue('simulate-fail') ?? '').split(',').filter(Boolean),
  /** Simulated flaky network: downloads drop once mid-way and must resume. */
  simulateFlaky: process.argv.includes('--simulate-flaky'),
  /** Speed multiplier for simulated work (higher = faster). */
  simulateSpeed: Number(argValue('simulate-speed') ?? '1') || 1,
  startHidden: process.argv.includes('--hidden'),
  /** Release CI: load the window, check IPC, write the result to this file and quit. */
  smokeTestResult: process.env['EVENTKIT_SMOKE_TEST'] || null,
  /** CI: run the real setup without sign-in, write a report to this file and quit. */
  setupTestResult: process.env['EVENTKIT_SETUP_TEST'] || null,
  /** "owner/repo" whose GitHub Releases feed auto-update; otherwise <server>/updates/. */
  updateRepo: import.meta.env.MAIN_VITE_UPDATE_REPO || null,
};

export const paths = {
  userData: () => app.getPath('userData'),
  file: (...p: string[]) => join(app.getPath('userData'), ...p),
  logs: () => join(app.getPath('userData'), 'logs'),
};
