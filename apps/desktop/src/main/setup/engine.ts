import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  COMPONENT_NAMES,
  type Arch,
  type Artifact,
  type ComponentId,
  type ManifestComponent,
  type ManifestPayload,
  type Platform,
  type SetupStep,
} from '@eventkit/shared';
import type { ComponentView, ReadinessView, SetupSnapshot } from '../../common/ipc';
import { errMsg, logger } from '../logger';
import { readJson, writeJson } from '../store';
import { artifactUrls, freeBytes, type DownloadProgress, type DownloadRequest } from './downloader';
import { EnvOverlay, type DesiredEnv } from './env-overlay';
import { chooseInstallRoot, installDirs } from './paths';
import {
  SetupError,
  type AnyRunner,
  type ComponentContext,
  type ComponentState,
  type PersistedSetupState,
  type ToolRunner,
} from './types';

const log = logger.scope('setup');

export interface ManifestSource {
  load(opts: { allowCached: boolean }): Promise<{ manifest: ManifestPayload; fromCache: boolean }>;
}

export interface DownloaderLike {
  download(
    req: DownloadRequest,
    onProgress?: (p: DownloadProgress) => void,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface EngineDeps {
  platform: Platform;
  arch: Arch;
  statePath: string;
  envStatePath: string;
  runners: Partial<Record<ComponentId, AnyRunner>>;
  manifestSource: ManifestSource;
  downloader: DownloaderLike;
  exec: ToolRunner;
  persistEnv: (env: DesiredEnv) => Promise<void>;
  simulate: boolean;
  elevateDelayMs?: number;
  /** Called after a run where every enabled component verified (readiness submission). */
  onComplete?: () => Promise<void>;
}

interface Live {
  percent: number;
  bytesTotal?: number;
  bytesDone?: number;
  speedBps?: number;
  etaSeconds?: number;
}

const emptyState = (): PersistedSetupState => ({
  schema: 1,
  installRoot: null,
  manifestId: null,
  components: {},
  facts: {},
  complete: false,
  lastVerifiedAt: null,
});

export class SetupEngine extends EventEmitter {
  private state: PersistedSetupState;
  private env: EnvOverlay;
  private manifest: ManifestPayload | null = null;
  private live = new Map<ComponentId, Live>();
  private running = false;
  private current: ComponentId | null = null;
  private abort: AbortController | null = null;
  private error: string | null = null;
  private elevationNotice: string | null = null;
  private prefetch = new Map<string, Promise<string>>();
  private readiness: ReadinessView = { state: 'unknown', reasons: [], checkedAt: null };
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: EngineDeps) {
    super();
    this.state = {
      ...emptyState(),
      ...readJson<PersistedSetupState>(deps.statePath, emptyState()),
    };
    this.env = new EnvOverlay(readJson<DesiredEnv | null>(deps.envStatePath, null) ?? undefined);
  }

  // ---------- public API ----------

  get facts() {
    return this.state.facts;
  }

  get currentManifest() {
    return this.manifest;
  }

  get overlay() {
    return this.env;
  }

  get isRunning() {
    return this.running;
  }

  get isComplete() {
    return this.state.complete;
  }

  get installRoot() {
    return this.state.installRoot;
  }

  setReadiness(r: ReadinessView) {
    this.readiness = r;
    this.emitNow();
  }

  componentStates() {
    return this.state.components;
  }

  snapshot(): SetupSnapshot {
    const m = this.manifest;
    const comps: ComponentView[] = (m?.components ?? []).map((c) => this.view(c));
    const enabled = (m?.components ?? []).filter((c) => c.enabled);
    let total = 0;
    let done = 0;
    for (const c of enabled) {
      const w = this.deps.runners[c.id]?.weight ?? 1;
      total += w;
      done += (w * this.view(c).percent) / 100;
    }
    const android = m?.components.find((c) => c.id === 'android');
    return {
      running: this.running,
      complete: this.state.complete,
      overallPercent: total ? Math.round((done / total) * 1000) / 10 : 0,
      currentComponent: this.current,
      components: comps,
      installRoot: this.state.installRoot,
      manifestId: m?.manifestId ?? null,
      placeholderManifest: Boolean(m?.placeholder),
      elevationNotice: this.elevationNotice,
      consentNotice:
        android?.enabled && android.id === 'android' && android.acceptLicenses
          ? 'Setup installs the Android SDK. By clicking "Set up my laptop" you accept the Android Software Development Kit License Agreement (https://developer.android.com/studio/terms).'
          : null,
      error: this.error,
      lastVerifiedAt: this.state.lastVerifiedAt,
      doctorWarnings: this.state.facts.doctorEval?.warnings ?? [],
      readiness: this.readiness,
    };
  }

  /** Load the manifest and detect what is already installed (no changes made). */
  async prepare(): Promise<void> {
    if (this.running) return;
    try {
      await this.loadManifest(true);
      this.emitNow();
    } catch (err) {
      this.error = errMsg(err);
      this.emitNow();
    }
  }

  /** Full run: detect everything, prefetch downloads, install missing components, verify. */
  async start(opts: { only?: ComponentId[]; force?: boolean } = {}): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.error = null;
    this.abort = new AbortController();
    this.emitNow();
    try {
      const manifest = await this.loadManifest(false);
      if (manifest.placeholder && !this.deps.simulate) {
        throw new SetupError(
          'The organizers have not published the setup manifest yet. Please try again later.',
        );
      }
      const ctx = this.context(manifest);
      const comps = manifest.components;
      const needsInstall = new Set<ComponentId>();

      // Phase A: detection (fast, read-only).
      for (const c of comps) {
        if (this.abort.signal.aborted) throw new Error('cancelled');
        if (!c.enabled) {
          this.setStatus(c.id, {
            status: 'disabled',
            step: undefined,
            message: undefined,
            error: undefined,
          });
          continue;
        }
        if (
          opts.only &&
          !opts.only.includes(c.id) &&
          this.state.components[c.id]?.status === 'verified'
        )
          continue;
        const runner = this.runner(c.id);
        this.current = c.id;
        this.setStatus(c.id, {
          status: 'running',
          step: 'detect',
          message: 'Checking…',
          error: undefined,
        });
        try {
          const det = await runner.detect(c, ctx);
          if (det.installed && !opts.force) {
            const v = await runner.verify(c, ctx);
            if (v.ok) {
              this.setStatus(c.id, {
                status: 'verified',
                step: 'verify',
                version: v.version ?? det.version,
                message: 'Already installed',
              });
              this.setLive(c.id, { percent: 100 });
              continue;
            }
            log.info(
              `${c.id}: installed but not valid (${v.detail ?? 'verify failed'}), will repair`,
            );
          }
        } catch (err) {
          log.warn(`${c.id}: detection error: ${errMsg(err)}`);
        }
        needsInstall.add(c.id);
        this.setStatus(c.id, { status: 'pending', step: undefined, message: 'Queued' });
        this.setLive(c.id, { percent: 0 });
      }
      this.current = null;

      // Phase B: disk space pre-check + prefetch downloads in the background.
      const artifacts = comps
        .filter((c) => needsInstall.has(c.id))
        .flatMap((c) =>
          this.runner(c.id)
            .artifacts(c, ctx)
            .map((a) => ({ c, a })),
        );
      await this.checkDisk(
        artifacts.map((x) => x.a),
        ctx.dirs.root,
      );
      for (const { c, a } of artifacts) this.startDownload(c.id, a, ctx);

      // Phase C: install in order, respecting dependencies.
      for (const c of comps) {
        if (!needsInstall.has(c.id)) continue;
        if (this.abort.signal.aborted) throw new Error('cancelled');
        const runner = this.runner(c.id);
        const blockers = runner
          .dependsOn(c, manifest)
          .filter((d) => manifest.components.find((x) => x.id === d)?.enabled)
          .filter((d) => this.state.components[d]?.status !== 'verified');
        if (blockers.length > 0) {
          this.setStatus(c.id, {
            status: 'pending',
            message: `Waiting for ${blockers.map((b) => COMPONENT_NAMES[b]).join(', ')}`,
          });
          continue;
        }
        await this.installOne(c, runner, ctx);
      }

      const enabled = comps.filter((c) => c.enabled);
      this.state.complete = enabled.every(
        (c) => this.state.components[c.id]?.status === 'verified',
      );
      this.state.lastVerifiedAt = new Date().toISOString();
      this.save();
      if (!this.state.complete) {
        const failed = enabled.filter((c) => this.state.components[c.id]?.status === 'failed');
        this.error = failed.length
          ? `${failed.length} step${failed.length > 1 ? 's' : ''} failed. Fix the issue shown and press Retry.`
          : 'Setup did not finish. Press Retry.';
      }
    } catch (err) {
      this.error = errMsg(err) === 'cancelled' ? 'Setup cancelled.' : errMsg(err);
      log.error(`setup run failed: ${this.error}`);
      this.state.complete = false;
      this.save();
    } finally {
      this.running = false;
      this.current = null;
      this.elevationNotice = null;
      this.prefetch.clear();
      this.emitNow();
    }
    if (this.state.complete && this.deps.onComplete) {
      await this.deps
        .onComplete()
        .catch((err: unknown) => log.error(`post-setup hook failed: ${errMsg(err)}`));
    }
  }

  /** Retry failed/blocked components (or one component). */
  async retry(componentId?: ComponentId) {
    if (componentId) {
      const s = this.state.components[componentId];
      if (s) s.attempts = 0;
    }
    await this.start({});
  }

  /** Force reinstall of everything that does not verify. */
  async repair() {
    await this.start({ force: false });
  }

  cancel() {
    this.abort?.abort();
  }

  /**
   * Quick local re-verification (launch / every 10 minutes): runs each component's
   * verify step without installing anything. Returns true when all pass.
   */
  async reverify(opts: { includeDoctor: boolean }): Promise<boolean> {
    if (this.running) return this.state.complete;
    let manifest: ManifestPayload;
    try {
      manifest = await this.loadManifest(true);
    } catch (err) {
      log.warn(`reverify: no manifest (${errMsg(err)})`);
      return this.state.complete;
    }
    if (!this.state.installRoot) return false;
    this.running = true;
    this.emitNow();
    const ctx = this.context(manifest, !opts.includeDoctor);
    let ok = true;
    try {
      for (const c of manifest.components) {
        if (!c.enabled) continue;
        if (c.id === 'verify' && !opts.includeDoctor) {
          if (this.state.components.verify?.status !== 'verified') ok = false;
          continue;
        }
        const prev = this.state.components[c.id];
        try {
          const v = await this.runner(c.id).verify(c, ctx);
          if (v.ok) {
            this.setStatus(c.id, {
              status: 'verified',
              version: v.version ?? prev?.version,
              error: undefined,
              message: prev?.message,
            });
            this.setLive(c.id, { percent: 100 });
          } else {
            ok = false;
            this.setStatus(c.id, {
              status: 'failed',
              error: v.detail ?? 'verification failed',
              message: 'Needs repair',
            });
            this.setLive(c.id, { percent: 0 });
          }
        } catch (err) {
          ok = false;
          this.setStatus(c.id, { status: 'failed', error: errMsg(err), message: 'Needs repair' });
        }
      }
    } finally {
      this.running = false;
    }
    this.state.complete = ok;
    this.state.lastVerifiedAt = new Date().toISOString();
    this.save();
    this.emitNow();
    log.info(`reverify: ${ok ? 'all components verified' : 'some components need repair'}`);
    return ok;
  }

  // ---------- internals ----------

  private runner(id: ComponentId): AnyRunner {
    const r = this.deps.runners[id];
    if (!r) throw new SetupError(`No installer for component ${id}`);
    return r;
  }

  private async loadManifest(allowCached: boolean): Promise<ManifestPayload> {
    const { manifest, fromCache } = await this.deps.manifestSource.load({ allowCached });
    if (fromCache) log.info('using cached manifest (server unreachable)');
    if (this.state.manifestId !== manifest.manifestId) {
      this.state.manifestId = manifest.manifestId;
      this.save();
    }
    this.manifest = manifest;
    for (const c of manifest.components) {
      if (!this.live.has(c.id)) {
        this.live.set(c.id, {
          percent: this.state.components[c.id]?.status === 'verified' ? 100 : 0,
        });
      }
    }
    return manifest;
  }

  private context(manifest: ManifestPayload, quick = false): ComponentContext {
    if (!this.state.installRoot) {
      const choice = chooseInstallRoot(this.deps.platform, this.state.installRoot);
      if (!choice.root) {
        throw new SetupError(
          `No usable install folder: ${choice.tried.map((t) => `${t.path} (${t.problem})`).join('; ')}`,
          'Ask a helper: the toolchain needs a writable folder without spaces or special characters.',
        );
      }
      this.state.installRoot = choice.root;
      this.save();
      log.info(`install root: ${choice.root}`);
    }
    const dirs = installDirs(this.state.installRoot);
    const signal = this.abort?.signal ?? new AbortController().signal;
    const ctx: ComponentContext = {
      manifest,
      platform: this.deps.platform,
      arch: this.deps.arch,
      dirs,
      facts: this.state.facts,
      env: this.env,
      exec: this.deps.exec,
      signal,
      simulate: this.deps.simulate,
      quick,
      log: logger.scope('setup'),
      step: (step: SetupStep, message?: string) => {
        if (!this.current) return;
        this.setStatus(this.current, { step, message });
      },
      progress: ({ percent, message }) => {
        if (!this.current) return;
        if (percent !== undefined)
          this.setLive(this.current, {
            ...this.live.get(this.current),
            percent: Math.min(99, percent),
          });
        if (message) this.setStatus(this.current, { message });
      },
      download: (artifact: Artifact) =>
        this.prefetch.get(this.downloadKey(artifact, dirs.downloads)) ??
        this.startDownload(this.current ?? 'system', artifact, ctx),
      elevate: async (reason: string) => {
        this.elevationNotice = reason;
        log.info(`elevation: ${reason}`);
        this.emitNow();
        await new Promise((r) => setTimeout(r, this.deps.elevateDelayMs ?? 3000));
      },
      save: () => this.save(),
    };
    return ctx;
  }

  private downloadKey(a: Artifact, downloadsDir: string) {
    return join(downloadsDir, `${a.sha256.slice(0, 12)}-${a.fileName}`);
  }

  private startDownload(id: ComponentId, a: Artifact, ctx: ComponentContext): Promise<string> {
    const dest = this.downloadKey(a, ctx.dirs.downloads);
    const existing = this.prefetch.get(dest);
    if (existing) return existing;
    const p = this.deps.downloader.download(
      {
        urls: artifactUrls(a, ctx.manifest.mirrorBaseUrl),
        dest,
        sha256: a.sha256,
        size: a.size,
        label: a.fileName,
      },
      (prog) => {
        const live = this.live.get(id) ?? { percent: 0 };
        const frac = prog.bytesTotal ? prog.bytesDone / prog.bytesTotal : 0;
        // Downloads account for the first 60% of a component's bar.
        this.setLive(id, {
          ...live,
          percent: Math.max(live.percent, Math.round(frac * 60)),
          bytesDone: prog.bytesDone,
          bytesTotal: prog.bytesTotal,
          speedBps: prog.speedBps,
          etaSeconds: prog.etaSeconds,
        });
        if (this.state.components[id]?.status === 'pending') {
          this.setStatus(id, { message: 'Downloading in background…' });
        }
      },
      ctx.signal,
    );
    p.catch(() => undefined); // surfaced when the component awaits it
    this.prefetch.set(dest, p);
    return p;
  }

  private async checkDisk(artifacts: Artifact[], root: string) {
    const needed = artifacts.reduce((s, a) => s + (a.size ?? 0), 0) * 2.2;
    const free = await freeBytes(root);
    if (free !== null && needed > 0 && free < needed) {
      throw new SetupError(
        `Not enough disk space: ${(needed / 1e9).toFixed(1)} GB needed, ${(free / 1e9).toFixed(1)} GB free on the install drive.`,
      );
    }
  }

  private async installOne(c: ManifestComponent, runner: AnyRunner, ctx: ComponentContext) {
    const prev = this.state.components[c.id];
    this.current = c.id;
    this.setStatus(c.id, {
      status: 'running',
      step: 'install',
      message: 'Starting…',
      error: undefined,
      attempts: (prev?.attempts ?? 0) + 1,
    });
    try {
      await runner.install(c, ctx);
      this.setStatus(c.id, { step: 'verify', message: 'Verifying…' });
      const v = await runner.verify(c, ctx);
      if (!v.ok) throw new SetupError(v.detail ?? 'Verification failed after install');
      this.setStatus(c.id, {
        status: 'verified',
        version: v.version,
        message: 'Installed',
        error: undefined,
      });
      this.setLive(c.id, { percent: 100 });
      await this.deps.persistEnv(this.env.toJSON()).catch((err: unknown) => {
        log.warn(`could not persist environment: ${errMsg(err)}`);
      });
      writeJson(this.deps.envStatePath, this.env.toJSON());
    } catch (err) {
      const msg = errMsg(err);
      const hint = err instanceof SetupError ? err.hint : undefined;
      log.error(`${c.id} failed: ${msg}`);
      this.setStatus(c.id, {
        status: 'failed',
        error: hint ? `${msg} ${hint}` : msg,
        message: 'Failed',
      });
      if (msg === 'cancelled') throw err;
    } finally {
      this.elevationNotice = null;
      this.current = null;
    }
  }

  private setStatus(id: ComponentId, patch: Partial<ComponentState>) {
    const prev = this.state.components[id] ?? { status: 'pending', attempts: 0, updatedAt: '' };
    this.state.components[id] = { ...prev, ...patch, updatedAt: new Date().toISOString() };
    if (patch.status && patch.status !== prev.status) {
      log.info(`${id}: ${prev.status} -> ${patch.status}${patch.error ? ` (${patch.error})` : ''}`);
      this.save();
      this.emitNow();
      this.emit('status', id, patch.status);
    } else {
      this.scheduleEmit();
    }
  }

  private setLive(id: ComponentId, l: Live) {
    this.live.set(id, l);
    this.scheduleEmit();
  }

  private view(c: ManifestComponent): ComponentView {
    const s = this.state.components[c.id];
    const l = this.live.get(c.id) ?? { percent: 0 };
    const status = c.enabled ? (s?.status ?? 'pending') : 'disabled';
    const percent = status === 'verified' || status === 'disabled' ? 100 : l.percent;
    return {
      id: c.id,
      name: c.name,
      required: c.required,
      enabled: c.enabled,
      status,
      step: s?.step,
      version: s?.version,
      message: s?.message,
      error: status === 'failed' ? s?.error : undefined,
      percent,
      bytesTotal: l.bytesTotal,
      bytesDone: l.bytesDone,
      speedBps: status === 'running' || status === 'pending' ? l.speedBps : undefined,
      etaSeconds: status === 'running' || status === 'pending' ? l.etaSeconds : undefined,
    };
  }

  private save() {
    writeJson(this.deps.statePath, this.state);
  }

  private scheduleEmit() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit('snapshot', this.snapshot());
    }, 200);
  }

  private emitNow() {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.emit('snapshot', this.snapshot());
  }
}
