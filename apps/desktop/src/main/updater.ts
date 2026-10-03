import { app, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { UpdateView } from '../common/ipc';
import { config } from './config';
import { errMsg, logger } from './logger';

const log = logger.scope('updater');
const CHECK_EVERY_MS = 4 * 3600_000;
const PAUSED = 'Updates wait until the offline phase is over.';

/** Nothing published yet: normal until organizers make the first release. */
const feedEmpty = (m: string) =>
  /Cannot find channel ".*" update info: HttpError: 404|No published versions on GitHub|Cannot find latest.*\.yml in the latest release artifacts/.test(
    m,
  );

/**
 * What this build can do about updates. Linux packages (deb, rpm, pacman) carry a
 * resources/package-type file that tells electron-updater how to install them (through
 * a pkexec password prompt); an AppImage replaces itself. macOS only installs updates
 * signed with the same Developer ID, so unsigned builds point to the download page.
 */
function updateMode(): UpdateView['mode'] {
  if (!config.packaged || process.env['EVENTKIT_DISABLE_UPDATES'] === '1') return 'off';
  if (process.platform === 'linux') {
    const packaged = existsSync(join(process.resourcesPath, 'package-type'));
    return process.env['APPIMAGE'] || packaged ? 'install' : 'off';
  }
  if (process.platform === 'darwin' && import.meta.env.MAIN_VITE_MAC_SIGNED !== '1') {
    return 'download';
  }
  return 'install';
}

let view: UpdateView = {
  mode: 'off',
  current: app.getVersion(),
  state: 'idle',
  latest: null,
  percent: null,
  error: null,
  checkedAt: null,
  paused: null,
  downloadUrl: null,
};
let canCheck = () => true;
let notify: (v: UpdateView) => void = () => undefined;

function set(patch: Partial<UpdateView>) {
  view = { ...view, ...patch };
  notify(view);
}

export function updateView(): UpdateView {
  return view;
}

/** Ask the release feed now (also run 30 s after start and every 4 hours). */
export async function checkForUpdates(): Promise<UpdateView> {
  if (view.mode === 'off') return view;
  // Never during the offline phase: the download needs internet and the restart to
  // install would show up as a monitoring gap.
  if (!canCheck()) {
    set({ paused: PAUSED });
    return view;
  }
  set({ paused: null });
  if (view.state === 'checking' || view.state === 'downloading' || view.state === 'ready') {
    return view;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    const msg = errMsg(err);
    if (feedEmpty(msg)) {
      log.info('no release published yet');
      set({ state: 'up-to-date' });
    } else {
      log.warn(`update check failed: ${msg}`);
      set({ state: 'error', error: msg });
    }
  }
  set({ checkedAt: new Date().toISOString() });
  return view;
}

/** Quit, install the downloaded update and start the new version. */
export function installUpdate() {
  if (view.mode !== 'install' || view.state !== 'ready') {
    throw new Error('No update is ready to install yet.');
  }
  if (!canCheck()) throw new Error(PAUSED);
  log.info(`installing ${view.latest} and restarting`);
  // Silent install, then start the new version.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

/**
 * Auto-update from the project's GitHub Releases (the release workflow bakes in the repo),
 * or from `<server>/updates/` for builds made without one. electron-updater checks the
 * sha512 from latest*.yml and, on Windows, the installer's Authenticode publisher.
 * Pre-releases (tags like v0.3.0-rc.1) are never offered.
 */
export function startAutoUpdate(opts: {
  canCheck: () => boolean;
  onChange: (v: UpdateView) => void;
}) {
  canCheck = opts.canCheck;
  notify = opts.onChange;
  const mode = updateMode();
  const [owner, repo] = config.updateRepo?.split('/') ?? [];
  const feed =
    owner && repo
      ? `https://github.com/${owner}/${repo}/releases`
      : `${config.apiBaseUrl}/updates/`;
  set({ mode, downloadUrl: owner && repo ? `${feed}/latest` : null });
  if (mode === 'off') {
    log.info('auto-update off for this build');
    return;
  }

  autoUpdater.logger = {
    info: (m: unknown) => log.info(String(m)),
    warn: (m: unknown) => log.warn(String(m)),
    error: (m: unknown) => {
      if (!feedEmpty(String(m))) log.error(String(m));
    },
    debug: (m: unknown) => log.debug(String(m)),
  };
  autoUpdater.setFeedURL(
    owner && repo
      ? { provider: 'github', owner, repo, releaseType: 'release' }
      : { provider: 'generic', url: feed },
  );
  // Download in the background so "Restart to update" is instant; macOS without a
  // Developer ID can't install, so it only reports the new version.
  autoUpdater.autoDownload = mode === 'install';
  autoUpdater.autoInstallOnAppQuit = mode === 'install';
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => set({ state: 'up-to-date', latest: null }));
  autoUpdater.on('update-available', (info) =>
    set({
      state: mode === 'install' ? 'downloading' : 'available',
      latest: info.version,
      percent: 0,
    }),
  );
  autoUpdater.on('download-progress', (p) =>
    set({ state: 'downloading', percent: Math.round(p.percent) }),
  );
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`update ${info.version} downloaded; it installs on restart`);
    set({ state: 'ready', latest: info.version, percent: 100 });
    if (Notification.isSupported()) {
      new Notification({
        title: 'EventKit update ready',
        body: `Version ${info.version} is ready. Open EventKit and click "Restart to update".`,
      }).show();
    }
  });
  autoUpdater.on('error', (err) => {
    if (feedEmpty(errMsg(err))) return;
    set({ state: 'error', error: errMsg(err) });
  });

  setTimeout(() => void checkForUpdates(), 30_000);
  setInterval(() => void checkForUpdates(), CHECK_EVERY_MS);
  log.info(`auto-update enabled (${app.getVersion()}, ${mode}, feed ${feed})`);
}
