import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, session, shell, type WebContents } from 'electron';
import { logger } from './logger';
import { sameRenderer } from './trusted-url';

const log = logger.scope('window');

let mainWindow: BrowserWindow | null = null;

export function rendererUrl(): string {
  const dev = process.env['ELECTRON_RENDERER_URL'];
  return dev && !app.isPackaged
    ? dev
    : pathToFileURL(join(__dirname, '../renderer/index.html')).href;
}

export function getMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** True when an IPC message comes from our own window and page. */
export function isTrustedSender(sender: WebContents, frameUrl: string | undefined): boolean {
  const win = getMainWindow();
  if (!win || sender.id !== win.webContents.id || !frameUrl) return false;
  return sameRenderer(frameUrl, rendererUrl());
}

/** Global hardening: no navigation, no new windows, no webviews, no permissions. */
export function hardenApp() {
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) {
        log.warn(`blocked navigation to ${url}`);
        event.preventDefault();
      }
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

export function createMainWindow(opts: { show: boolean }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: 'EventKit',
    autoHideMenuBar: true,
    backgroundColor: '#0b1220',
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  win.removeMenu();
  win.once('ready-to-show', () => {
    if (opts.show) win.show();
  });
  void win.loadURL(rendererUrl());
  mainWindow = win;
  return win;
}
