import { app, clipboard, net, session, shell } from 'electron';
import { z } from 'zod';
import { EmailSchema } from '@eventkit/shared';
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
import { realRunners } from './setup/components';
import { Downloader } from './setup/downloader';
import { SetupEngine } from './setup/engine';
import { persistPosix, persistWindows } from './setup/env-persist';
import { run } from './setup/exec';
import { simulatedDownloader, simulatedRunners } from './setup/simulate';
import { createTray } from './tray';
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
    log.info('setup complete');
  },
});

const reporter = new ProgressReporter();
engine.on('snapshot', (s) => {
  send('setup:snapshot', s);
  reporter.push(s);
});
engine.on('status', () => reporter.push(engine.snapshot(), true));
auth.on('changed', (s) => send('auth:changed', s));
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
  handle(CHANNELS.requestOtp, z.object({ email: EmailSchema }), ({ email }) =>
    auth.requestOtp(email),
  );
  handle(
    CHANNELS.verifyOtp,
    z.object({ email: EmailSchema, code: z.string().regex(/^\d{6}$/) }),
    async ({ email, code }) => {
      const state = await auth.verifyOtp(email, code);
      void engine.prepare();
      return state;
    },
  );
  handle(CHANNELS.signOut, null, () => auth.signOut());
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
  handle(CHANNELS.setupReverify, null, async () => {
    await engine.reverify({ includeDoctor: true });
  });
  handle(CHANNELS.setupRepair, null, () => {
    void engine.repair();
  });
  handle(CHANNELS.copyDiagnostics, null, () => {
    clipboard.writeText(diagnostics());
  });

  handle(CHANNELS.qrCurrent, null, (): QrView => ({
    visible: false,
    reason: 'Finish setup to get your QR code.',
    checkedIn: false,
  }));
  handle(CHANNELS.phase2State, null, (): Phase2View => idlePhase2());
  handle(CHANNELS.phase2Sync, null, () => undefined);

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

function idlePhase2(): Phase2View {
  return {
    state: 'none',
    startAt: null,
    endAt: null,
    mode: 'strict',
    graceSeconds: 0,
    msToStart: null,
    msToEnd: null,
    net: 'offline',
    interfaces: [],
    lastCheckAt: null,
    compliance: 'pending',
    violationCount: 0,
    onlineSeconds: 0,
    pendingUpload: 0,
    lastSyncAt: null,
    safeToDisconnect: false,
    projectDir: engine.facts.projectDir ?? null,
  };
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
      quit: () => app.quit(),
    });

    if (auth.state().signedIn) {
      void auth.refresh();
      void api.syncClock().catch(() => undefined);
      await engine.prepare();
      if (engine.isComplete) void engine.reverify({ includeDoctor: !config.simulate });
    }
    // Re-verify the toolchain every 10 minutes; refresh profile (check-in badge) every 30 s.
    setInterval(() => {
      if (auth.state().signedIn && engine.installRoot)
        void engine.reverify({ includeDoctor: false });
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
