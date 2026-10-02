import { app, clipboard, dialog, net, Notification, powerMonitor, session, shell } from 'electron';
import { z } from 'zod';
import type { AppInfo, Phase2View, QrView } from '../common/ipc';
import { CHANNELS } from '../common/ipc';
import { api } from './api';
import { auth } from './auth';
import { config, paths } from './config';
import { currentArch, currentPlatform, osVersion } from './device';
import { handle, send } from './ipc';
import { errMsg, logger } from './logger';
import { manifestSource } from './manifest';
import { ProgressReporter } from './progress-reporter';
import { currentQr } from './qr';
import { submitReadiness } from './readiness';
import { secureStore } from './secure-store';
import { msUntilNextWindow } from '@eventkit/shared/node';
import { realRunners } from './setup/components';
import { Downloader } from './setup/downloader';
import { SetupEngine } from './setup/engine';
import { persistPosix, persistWindows } from './setup/env-persist';
import { run } from './setup/exec';
import { simulatedDownloader, simulatedRunners } from './setup/simulate';
import { setAutoLaunch } from './autolaunch';
import { Phase2Controller } from './phase2/controller';
import { createTray, setTrayStatus } from './tray';
import { startAutoUpdate } from './updater';
import { createMainWindow, getMainWindow, hardenApp } from './window';
import { homedir } from 'node:os';
import { flutterBin } from './setup/paths';
import { installDirs } from './setup/paths';

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

logger.init(paths.logs());
const log = logger.scope('main');
log.info(
  `EventKit ${app.getVersion()} starting (${process.platform}/${process.arch}${config.simulate ? ', SIMULATE' : ''})`,
);

const platform = currentPlatform();
const arch = currentArch();
const simOpts = {
  speed: config.simulateSpeed,
  failures: config.simulateFailures,
  flaky: config.simulateFlaky,
};

const engine = new SetupEngine({
  platform,
  arch,
  statePath: paths.file(config.simulate ? 'setup-state.simulate.json' : 'setup-state.json'),
  envStatePath: paths.file(config.simulate ? 'env.simulate.json' : 'env.json'),
  runners: config.simulate
    ? simulatedRunners(simOpts)
    : realRunners({ resolveProxy: (url) => session.defaultSession.resolveProxy(url) }),
  manifestSource,
  downloader: config.simulate
    ? simulatedDownloader(simOpts)
    : new Downloader({
        fetch: (url, init) => net.fetch(url, { ...init, cache: 'no-store' }),
        log: (m) => logger.log('info', 'download', m),
      }),
  exec: { run },
  persistEnv: async (env) => {
    if (config.simulate) return;
    if (platform === 'windows') log.info(`env: ${await persistWindows(env)}`);
    else
      log.info(
        `env: updated ${(await persistPosix(env, homedir(), platform)).join(', ') || 'nothing'}`,
      );
  },
  simulate: config.simulate,
  elevateDelayMs: config.simulate ? 1500 : 3000,
  onComplete: async () => {
    log.info('setup complete; submitting readiness report');
    await submitReadiness(engine);
    void pushQr();
  },
});

const phase2 = new Phase2Controller({
  probe: { fetch: (url, init) => net.fetch(url, init), serverUrl: config.apiBaseUrl },
  onView: (view) => {
    send('phase2:changed', view);
    updateTray(view);
  },
  onDisconnectNow: () => {
    const win = getMainWindow() ?? createMainWindow({ show: true });
    win.show();
    win.focus();
    if (Notification.isSupported()) {
      new Notification({
        title: 'Offline phase started: disconnect now',
        body: 'Turn off Wi-Fi and unplug Ethernet. Time online is being recorded.',
        urgency: 'critical',
      }).show();
    }
  },
  projectDir: () => engine.facts.projectDir ?? null,
});

let lastTray = '';
function updateTray(v: Phase2View) {
  let state: 'idle' | 'ok' | 'warn' | 'bad' = 'idle';
  let line = 'EventKit';
  if (v.state === 'active') {
    state = v.net === 'online' ? 'bad' : v.net === 'limited' && v.mode === 'strict' ? 'warn' : 'ok';
    line =
      v.net === 'online' ? 'Offline phase: ONLINE, disconnect now' : 'Offline phase: monitoring';
  } else if (v.state === 'presync') {
    line = v.safeToDisconnect
      ? 'Offline phase soon: safe to disconnect'
      : 'Offline phase soon: syncing';
  } else if (v.state === 'ended' && v.pendingUpload > 0) {
    state = 'warn';
    line = 'Offline phase ended: reconnect to upload the log';
  }
  const key = `${state}|${line}`;
  if (key !== lastTray) {
    lastTray = key;
    setTrayStatus(state, line);
  }
}

const reporter = new ProgressReporter();
engine.on('snapshot', (s) => {
  send('setup:snapshot', s);
  reporter.push(s);
});
engine.on('status', () => reporter.push(engine.snapshot(), true));
engine.on('published', () => {
  if (engine.isComplete || !Notification.isSupported()) return;
  new Notification({
    title: 'Setup is open',
    body: 'The organizers published the install list. Open EventKit and click "Set up my laptop".',
  }).show();
});
auth.on('changed', (s) => {
  send('auth:changed', s);
  void pushQr();
});

async function pushQr() {
  if (getMainWindow()) send('qr:changed', await currentQr(engine));
}

/** Refresh the QR exactly at each 60 s window boundary. */
function scheduleQrTick() {
  setTimeout(
    () => {
      void pushQr();
      scheduleQrTick();
    },
    msUntilNextWindow(Date.now(), api.serverOffsetMs) + 50,
  );
}

/**
 * Local re-verification. A regression hides the QR and is reported to the
 * server (scans refused); a repaired toolchain is re-submitted for readiness.
 */
async function reverifyAndReport(includeDoctor: boolean) {
  const wasReady = Boolean(auth.profile?.ready);
  const ok = await engine.reverify({ includeDoctor });
  if (ok && (!secureStore.get('qrSecret') || !auth.profile?.ready)) await submitReadiness(engine);
  else if (!ok && wasReady) await submitReadiness(engine, { force: true });
  await pushQr();
}
logger.on('line', (line) => send('log:line', line));

function registerIpc() {
  handle(CHANNELS.appInfo, null, (): AppInfo => ({
    version: app.getVersion(),
    os: platform,
    arch,
    osVersion: osVersion(),
    simulate: config.simulate,
    apiBaseUrl: config.apiBaseUrl,
    packaged: config.packaged,
  }));
  handle(CHANNELS.openExternal, z.string().url().startsWith('https://'), (url) =>
    shell.openExternal(url),
  );

  handle(CHANNELS.authState, null, () => auth.state());
  handle(CHANNELS.signInWithGoogle, null, async () => {
    const state = await auth.signInWithGoogle();
    // The browser had focus; bring the app back to the front.
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    void engine.prepare();
    setAutoLaunch(true);
    return state;
  });
  handle(CHANNELS.cancelSignIn, null, () => auth.cancelSignIn());
  handle(CHANNELS.reopenSignIn, null, () => auth.reopenSignIn());
  handle(CHANNELS.signOut, null, async () => {
    await auth.signOut();
    setAutoLaunch(false);
  });
  handle(CHANNELS.authRefresh, null, () => auth.refresh());

  handle(CHANNELS.setupSnapshot, null, () => engine.snapshot());
  handle(CHANNELS.setupStart, null, () => {
    void engine.start();
  });
  handle(
    CHANNELS.setupRetry,
    z.object({ componentId: z.string().optional() }),
    ({ componentId }) => {
      void engine.retry(componentId as never);
    },
  );
  handle(CHANNELS.setupCancel, null, () => engine.cancel());
  handle(CHANNELS.setupReverify, null, () => reverifyAndReport(!config.simulate));
  handle(CHANNELS.setupRepair, null, () => {
    void engine.repair();
  });
  handle(CHANNELS.copyDiagnostics, null, () => {
    clipboard.writeText(diagnostics());
  });

  handle(CHANNELS.qrCurrent, null, (): Promise<QrView> => currentQr(engine));
  handle(CHANNELS.phase2State, null, (): Phase2View => phase2.view());
  handle(CHANNELS.phase2Sync, null, () => phase2.syncNow());

  handle(CHANNELS.openVsCode, null, async () => {
    const cli = engine.facts.vscodeCli;
    if (!cli) throw new Error('VS Code is not installed yet');
    const target = engine.facts.projectDir ?? engine.installRoot ?? homedir();
    await run(cli, [target], { env: engine.overlay.childEnv(), detached: true });
  });
  handle(CHANNELS.openProjectFolder, null, async () => {
    const dir = engine.facts.projectDir;
    if (!dir) throw new Error('The starter project is not set up yet');
    const err = await shell.openPath(dir);
    if (err) throw new Error(err);
  });
  handle(CHANNELS.runDoctor, null, async () => {
    if (config.simulate)
      return engine.facts.doctorOutput ?? 'flutter doctor (simulated): no output yet';
    const root = engine.installRoot;
    if (!root) throw new Error('Flutter is not installed yet');
    const res = await run(flutterBin(installDirs(root), platform), ['doctor', '-v'], {
      env: engine.overlay.childEnv(),
      allowFailure: true,
      timeoutMs: 5 * 60_000,
    });
    return `${res.stdout}\n${res.stderr}`.trim();
  });

  handle(CHANNELS.logsRecent, null, () => logger.recent());
  handle(CHANNELS.logsOpenFolder, null, async () => {
    await shell.openPath(paths.logs());
  });
}

function diagnostics(): string {
  const s = engine.snapshot();
  return JSON.stringify(
    {
      app: {
        version: app.getVersion(),
        platform,
        arch,
        osVersion: osVersion(),
        simulate: config.simulate,
        api: config.apiBaseUrl,
      },
      attendee: auth.profile ? { id: auth.profile.id, status: auth.profile.status } : null,
      setup: {
        complete: s.complete,
        overallPercent: s.overallPercent,
        installRoot: s.installRoot,
        manifestId: s.manifestId,
        error: s.error,
        components: s.components.map((c) => ({
          id: c.id,
          status: c.status,
          step: c.step,
          version: c.version,
          error: c.error,
        })),
      },
      facts: { ...engine.facts, doctorOutput: undefined },
      doctorOutput: engine.facts.doctorOutput,
      recentLog: logger
        .recent()
        .slice(-300)
        .map((l) => `${new Date(l.t).toISOString()} ${l.level} [${l.scope}] ${l.msg}`),
    },
    null,
    2,
  );
}

app.on('second-instance', () => {
  const win = getMainWindow() ?? createMainWindow({ show: true });
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app
  .whenReady()
  .then(async () => {
    hardenApp();
    registerIpc();
    createMainWindow({ show: !config.startHidden });
    createTray({
      show: () => (getMainWindow() ?? createMainWindow({ show: true })).show(),
      quit: () => void requestQuit(),
    });
    powerMonitor.on('suspend', () => phase2.onSuspend());
    powerMonitor.on('resume', () => phase2.onResume());
    phase2.start();
    startAutoUpdate({ canCheck: () => !phase2.isActive });

    scheduleQrTick();
    if (auth.state().signedIn) {
      void auth.refresh();
      void api.syncClock().catch(() => undefined);
      await engine.prepare();
      if (engine.isComplete) void reverifyAndReport(!config.simulate);
    }
    // Re-verify the toolchain every 10 minutes; refresh profile (check-in badge) every 30 s.
    setInterval(() => {
      if (auth.state().signedIn && engine.installRoot) void reverifyAndReport(false);
    }, 10 * 60_000);
    setInterval(() => {
      if (auth.state().signedIn) void auth.refresh();
    }, 30_000);
  })
  .catch((err: unknown) => {
    log.error(`startup failed: ${errMsg(err)}`);
  });

app.on('window-all-closed', () => {
  // Stay alive in the tray (needed for phase-2 monitoring); quit via tray menu.
});

let quitting = false;
/** Quitting during the offline phase is allowed but recorded; confirm first. */
async function requestQuit() {
  if (phase2.isActive) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Keep running', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      title: 'Offline phase in progress',
      message: 'EventKit is monitoring the offline phase.',
      detail: 'If you quit, the time until you restart it is recorded as a monitoring gap.',
    });
    if (response !== 1) return;
  }
  quitting = true;
  app.quit();
}

app.on('before-quit', () => {
  quitting = true;
  phase2.recordAppStop();
  phase2.stop();
});

app.on('browser-window-created', (_e, win) => {
  // Closing the window hides it to the tray; the monitor keeps running.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
});
