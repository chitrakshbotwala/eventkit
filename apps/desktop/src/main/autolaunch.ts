import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { errMsg, logger } from './logger';

const log = logger.scope('autolaunch');
const LINUX_FILE = join(homedir(), '.config', 'autostart', 'eventkit.desktop');

/**
 * Start hidden in the tray at login so phase-2 monitoring survives reboots.
 * Only for packaged builds (a dev build would register the Electron binary).
 */
export function setAutoLaunch(enabled: boolean) {
  if (!app.isPackaged) return;
  try {
    if (process.platform === 'linux') {
      if (!enabled) {
        rmSync(LINUX_FILE, { force: true });
        return;
      }
      // AppImages are re-mounted on every start: autostart the .AppImage file itself.
      const exe = process.env['APPIMAGE'] ?? process.execPath;
      mkdirSync(join(homedir(), '.config', 'autostart'), { recursive: true });
      writeFileSync(
        LINUX_FILE,
        [
          '[Desktop Entry]',
          'Type=Application',
          'Name=EventKit',
          `Exec="${exe}" --hidden`,
          'X-GNOME-Autostart-enabled=true',
          'NoDisplay=false',
          '',
        ].join('\n'),
      );
      return;
    }
    app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
  } catch (err) {
    log.warn(`could not update login item: ${errMsg(err)}`);
  }
}

export function autoLaunchEnabled(): boolean {
  if (process.platform === 'linux') return existsSync(LINUX_FILE);
  return app.getLoginItemSettings().openAtLogin;
}
