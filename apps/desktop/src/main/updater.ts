import { app, Notification } from 'electron';
import { autoUpdater } from 'electron-updater';
import { config } from './config';
import { errMsg, logger } from './logger';

const log = logger.scope('updater');
const CHECK_EVERY_MS = 4 * 3600_000;

/** No latest*.yml on the server yet: normal until organizers publish a release. */
const feedEmpty = (m: string) => /Cannot find channel ".*" update info: HttpError: 404/.test(m);

/**
 * Auto-update from the event server (`<server>/updates/`), which organizers fill
 * with the release artifacts (latest*.yml + installers). electron-updater checks the
 * sha512 from latest*.yml and, on Windows, the installer's Authenticode publisher.
 *
 * Never checks while the offline phase is running: the download needs internet and
 * the restart to install would show up as a monitoring gap.
 */
export function startAutoUpdate(opts: { canCheck: () => boolean }) {
  if (!config.packaged || process.env['EVENTKIT_DISABLE_UPDATES'] === '1') return;
  // deb/rpm installs are updated by the package manager; only AppImage self-updates on Linux.
  if (process.platform === 'linux' && !process.env['APPIMAGE']) return;

  autoUpdater.logger = {
    info: (m: unknown) => log.info(String(m)),
    warn: (m: unknown) => log.warn(String(m)),
    error: (m: unknown) => {
      if (!feedEmpty(String(m))) log.error(String(m));
    },
    debug: (m: unknown) => log.debug(String(m)),
  };
  autoUpdater.setFeedURL({ provider: 'generic', url: `${config.apiBaseUrl}/updates/` });
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
      if (feedEmpty(msg)) log.info('no release published on the server yet');
      else log.warn(`update check failed: ${msg}`);
    });
  };
  setTimeout(check, 30_000);
  setInterval(check, CHECK_EVERY_MS);
  log.info(`auto-update enabled (${app.getVersion()}, feed ${config.apiBaseUrl}/updates/)`);
}
