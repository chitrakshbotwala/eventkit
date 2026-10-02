import { app, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import { config } from './config';
import { errMsg, logger } from './logger';

const log = logger.scope('updater');
const CHECK_EVERY_MS = 4 * 3600_000;

/** Nothing published yet: normal until organizers make the first release. */
const feedEmpty = (m: string) =>
  /Cannot find channel ".*" update info: HttpError: 404|No published versions on GitHub|Cannot find latest.*\.yml in the latest release artifacts/.test(
    m,
  );

/**
 * Auto-update from the project's GitHub Releases (the release workflow bakes in the repo),
 * or from `<server>/updates/` for builds made without one. electron-updater checks the
 * sha512 from latest*.yml and, on Windows, the installer's Authenticode publisher.
 * Pre-releases (tags like v0.3.0-rc.1) are never offered.
 *
 * Never checks while the offline phase is running: the download needs internet and
 * the restart to install would show up as a monitoring gap.
 */
export function startAutoUpdate(opts: { canCheck: () => boolean }) {
  if (!config.packaged || process.env['EVENTKIT_DISABLE_UPDATES'] === '1') return;
  // deb/rpm installs are updated by the package manager; only AppImage self-updates on Linux.
  if (process.platform === 'linux' && !process.env['APPIMAGE']) return;
  // macOS only installs updates signed with the same Developer ID as the running app.
  if (process.platform === 'darwin' && import.meta.env.MAIN_VITE_MAC_SIGNED !== '1') {
    log.info('auto-update off: this macOS build is not Developer ID signed');
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
  const [owner, repo] = config.updateRepo?.split('/') ?? [];
  const feed =
    owner && repo
      ? `https://github.com/${owner}/${repo}/releases`
      : `${config.apiBaseUrl}/updates/`;
  autoUpdater.setFeedURL(
    owner && repo
      ? { provider: 'github', owner, repo, releaseType: 'release' }
      : { provider: 'generic', url: feed },
  );
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  autoUpdater.on('update-downloaded', (info) => {
    log.info(`update ${info.version} downloaded; it installs the next time EventKit quits`);
    if (Notification.isSupported()) {
      new Notification({
        title: 'EventKit update ready',
        body: `Version ${info.version} installs the next time EventKit restarts.`,
      }).show();
    }
  });

  const check = () => {
    if (!opts.canCheck()) return;
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      const msg = errMsg(err);
      if (feedEmpty(msg)) log.info('no release published yet');
      else log.warn(`update check failed: ${msg}`);
    });
  };
  setTimeout(check, 30_000);
  setInterval(check, CHECK_EVERY_MS);
  log.info(`auto-update enabled (${app.getVersion()}, feed ${feed})`);
}
