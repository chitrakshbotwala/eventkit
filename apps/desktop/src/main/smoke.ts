import { app, type BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import { logger } from './logger';
import { secureStore } from './secure-store';

/**
 * Release CI launches every packaged build with EVENTKIT_SMOKE_TEST=<result file>. The
 * app loads its window, makes one IPC round trip from the renderer (which proves the
 * asar, the preload and the IPC sender check work in the installed layout), writes the
 * result and quits. It changes nothing else: it is only a way to exit early.
 */
export function runSmokeTest(win: BrowserWindow, resultFile: string) {
  let done = false;
  const finish = (ok: boolean, detail: string) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    const result = {
      ok,
      detail,
      version: app.getVersion(),
      platform: `${process.platform}/${process.arch}`,
      ozonePlatform: app.commandLine.getSwitchValue('ozone-platform') || null,
      waylandDisplay: process.env['WAYLAND_DISPLAY'] ?? null,
      x11Display: process.env['DISPLAY'] ?? null,
      log: logger
        .recent()
        .slice(-40)
        .map((l) => `${l.level} [${l.scope}] ${l.msg}`),
    };
    try {
      writeFileSync(resultFile, JSON.stringify(result, null, 2));
    } finally {
      app.exit(ok ? 0 : 1);
    }
  };
  const timer = setTimeout(() => finish(false, 'window did not load within 90 s'), 90_000);

  win.webContents.once('did-fail-load', (_e, code, description) =>
    finish(false, `renderer failed to load: ${code} ${description}`),
  );
  win.webContents.once('render-process-gone', (_e, details) =>
    finish(false, `renderer crashed: ${details.reason}`),
  );
  win.webContents.once('did-finish-load', () => {
    win.webContents
      .executeJavaScript('window.eventkit.auth.state().then((s) => JSON.stringify(s))', true)
      .then((state: string) => {
        // Sign-in stores the session here: a desktop without a usable keyring must still work.
        const storage = secureStore.selfTest();
        finish(true, `IPC round trip ok: ${state}; secure storage: ${storage}`);
      })
      .catch((err: unknown) => finish(false, `IPC round trip failed: ${String(err)}`));
  });
}
