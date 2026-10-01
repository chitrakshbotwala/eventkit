import { EventEmitter } from 'node:events';
import { app } from 'electron';
import {
  classifyNetState,
  ConnectivityAckSchema,
  ScheduleResponseSchema,
  type NetState,
  type PhaseState,
  type Schedule,
} from '@eventkit/shared';
import type { Phase2View } from '../../common/ipc';
import { api } from '../api';
import { auth } from '../auth';
import { paths } from '../config';
import { errMsg, logger } from '../logger';
import { readJson, writeJson } from '../store';
import { LocalLog, monoNow } from './eventlog';
import { activeInterfaces, probeReachability, type ProbeDeps, type ProbeResult } from './netprobe';
import { inEnforcedWindow, isMonitoring, phaseState } from './state';

const log = logger.scope('phase2');

const SCHEDULE_SYNC_MS = 60_000;
const PROBE_MS = 5_000;
const CLOCK_TOLERANCE_MS = 10_000;
const UPLOAD_RETRY_MS = 60_000;

export interface ControllerDeps {
  probe: Omit<ProbeDeps, 'timeoutMs'>;
  /** Called when the view changes (renderer + tray). */
  onView(view: Phase2View): void;
  /** Called when the phase starts while the laptop is online. */
  onDisconnectNow(): void;
  projectDir(): string | null;
}

/**
 * Phase-2 orchestration: schedule sync (online), final pre-phase sync, the
 * connectivity monitor, the tamper-evident local log, realtime event delivery
 * and the full-log upload once the laptop is back online.
 */
export class Phase2Controller extends EventEmitter {
  private schedule: Schedule | null = readJson<Schedule | null>(paths.file('schedule.json'), null);
  private lastSyncAt: number | null = null;
  private phase: PhaseState = 'none';
  private readonly log: LocalLog;
  private net: NetState = 'offline';
  private ifaces: string[] = [];
  private lastProbe: ProbeResult | null = null;
  private lastProbeAt = 0;
  private probing = false;
  private lastHeartbeat = 0;
  private lastWall = Date.now();
  private lastMono = monoNow();
  private justResumed = false;
  private safeToDisconnect = false;
  private presyncDone = false;
  private flushing = false;
  private lastUploadTry = 0;
  private violationCount = 0;
  private onlineMs = 0;
  private limitedSeen = false;
  /** The current online run was already counted as a violation. */
  private onlineRunCounted = false;
  private wasEnforced = false;
  private lastTick = Date.now();
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly deps: ControllerDeps) {
    super();
    this.log = new LocalLog(paths.file('connectivity'), () => auth.deviceKey, () => api.serverOffsetMs);
    const stats = readJson<{ logId?: string; violations?: number; onlineMs?: number; limited?: boolean }>(
      paths.file('phase2-stats.json'),
      {},
    );
    if (stats.logId && stats.logId === this.log.current?.logId) {
      this.violationCount = stats.violations ?? 0;
      this.onlineMs = stats.onlineMs ?? 0;
      this.limitedSeen = stats.limited ?? false;
    }
  }

  private serverNow() {
    return Date.now() + api.serverOffsetMs;
  }

  start() {
    // phase starts as "none": the first tick performs the real transition (opening,
    // resuming or closing the log as needed).
    void this.syncSchedule();
    this.timers.push(setInterval(() => void this.syncSchedule(), SCHEDULE_SYNC_MS));
    this.timers.push(setInterval(() => void this.tick(), 1_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Graceful quit: record it so the server sees an explained gap rather than silence. */
  recordAppStop() {
    if (this.log.isOpen) this.log.append('app_stop', {});
  }

  onSuspend() {
    if (this.log.isOpen) this.log.append('suspend', {});
  }

  onResume() {
    this.justResumed = true;
    if (this.log.isOpen) this.log.append('resume', { state: this.net });
    void this.probeNow();
  }

  get isActive() {
    return this.phase === 'active' || this.phase === 'presync';
  }

  // ---------- schedule ----------

  async syncSchedule(): Promise<boolean> {
    try {
      const t0 = Date.now();
      const res = await api.request('/api/schedule', ScheduleResponseSchema, { timeoutMs: 8_000 });
      api.setOffset(res.serverTime - (t0 + Date.now()) / 2);
      const changed = JSON.stringify(res.schedule) !== JSON.stringify(this.schedule);
      this.schedule = res.schedule;
      this.lastSyncAt = Date.now();
      if (changed) {
        writeJson(paths.file('schedule.json'), res.schedule);
        log.info(`schedule v${res.schedule.version}: ${res.schedule.startAt ?? '-'} -> ${res.schedule.endAt ?? '-'} (${res.schedule.mode})`);
      }
      this.emitView();
      return true;
    } catch (err) {
      log.debug(`schedule sync failed: ${errMsg(err)}`);
      return false;
    }
  }

  // ---------- main loop ----------

  private ticking = false;

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickInner();
    } finally {
      this.ticking = false;
    }
  }

  private async tickInner() {
    const now = this.serverNow();
    const next = phaseState(this.schedule, now);
    if (next !== this.phase) await this.transition(this.phase, next);

    this.checkClock();
    const monitoring = isMonitoring(this.phase);
    if (monitoring) {
      const ifaces = activeInterfaces();
      const changed = ifaces.join(',') !== this.ifaces.join(',');
      this.ifaces = ifaces;
      // Interface changes trigger an immediate probe so short Wi-Fi blips are caught.
      if (changed || Date.now() - this.lastProbeAt >= PROBE_MS) void this.probeNow();
      const hb = (this.schedule?.heartbeatSeconds ?? 60) * 1000;
      const enforced = inEnforcedWindow(this.schedule, now);
      // Extra heartbeat when the grace period ends, so a laptop that is still online
      // shows up as a violation right away instead of at the next regular heartbeat.
      const graceEnded = enforced && !this.wasEnforced;
      this.wasEnforced = enforced;
      if (graceEnded || Date.now() - this.lastHeartbeat >= hb) {
        this.lastHeartbeat = Date.now();
        this.log.append('heartbeat', { state: this.net, interfaces: this.ifaces });
      }
      this.accumulate(now);
    }
    if (this.log.current && (this.phase === 'ended' || this.phase === 'none' || this.phase === 'scheduled' || this.net === 'online')) {
      if (Date.now() - this.lastUploadTry >= UPLOAD_RETRY_MS && this.log.pendingUpload > 0) void this.uploadLog();
    }
    this.lastTick = Date.now();
    this.emitView();
  }

  private accumulate(now: number) {
    const dt = Date.now() - this.lastTick;
    if (this.net === 'online' && inEnforcedWindow(this.schedule, now)) {
      // Counted here rather than on the transition so being online when the grace
      // period ends is a violation too.
      if (!this.onlineRunCounted) {
        this.onlineRunCounted = true;
        this.violationCount++;
      }
      this.onlineMs += Math.min(dt, 5_000);
      this.saveStats();
    }
  }

  private async transition(from: PhaseState, to: PhaseState) {
    log.info(`phase ${from} -> ${to}`);
    this.phase = to;
    if (to === 'presync' || to === 'active') {
      this.ensureLog('app_start');
      if (to === 'presync') void this.finalSync();
      if (to === 'active') {
        await this.probeNow();
        this.log.append('phase_start', { state: this.net, scheduleVersion: this.schedule?.version });
        if (this.net === 'online') this.deps.onDisconnectNow();
      }
    } else if (this.log.isOpen) {
      this.log.append('phase_end', { state: this.net, scheduleVersion: this.schedule?.version });
      this.log.close();
      this.safeToDisconnect = false;
      this.presyncDone = false;
      void this.uploadLog();
    }
    this.emitView();
  }

  /** Open (or resume) the phase log and mark that the monitor is running. */
  private ensureLog(firstType: 'app_start') {
    if (!this.log.isOpen) {
      if (this.log.current && !this.log.finished) {
        log.warn('previous phase log was never uploaded; starting a new one');
      }
      this.log.open(this.schedule?.version ?? 0);
      this.violationCount = 0;
      this.onlineMs = 0;
      this.limitedSeen = false;
      this.onlineRunCounted = false;
      this.saveStats();
    }
    this.log.append(firstType, { appVersion: app.getVersion(), state: this.net, interfaces: activeInterfaces() });
    this.lastHeartbeat = Date.now();
  }

  /** Before the phase: sync schedule + clock, flush realtime events, upload the log. */
  private async finalSync() {
    if (this.presyncDone) return;
    const ok = await this.syncSchedule();
    await api.syncClock().catch(() => undefined);
    await this.flushRealtime();
    await this.uploadLog();
    if (ok) {
      this.presyncDone = true;
      this.safeToDisconnect = true;
      log.info('final pre-phase sync done: safe to disconnect');
      this.emitView();
    }
  }

  private checkClock() {
    const wall = Date.now();
    const mono = monoNow();
    const dWall = wall - this.lastWall;
    const dMono = mono - this.lastMono;
    this.lastWall = wall;
    this.lastMono = mono;
    if (this.justResumed) {
      this.justResumed = false;
      return;
    }
    if (Math.abs(dWall - dMono) > CLOCK_TOLERANCE_MS && this.log.isOpen) {
      log.warn(`clock anomaly: wall ${dWall} ms vs monotonic ${dMono} ms`);
      this.log.append('clock_anomaly', { wallDeltaMs: dWall, monoDeltaMs: dMono });
    }
  }

  async probeNow() {
    if (this.probing) return;
    this.probing = true;
    try {
      const ifaces = activeInterfaces();
      const res = await probeReachability(this.deps.probe);
      this.lastProbe = res;
      this.lastProbeAt = Date.now();
      this.ifaces = ifaces;
      const state = classifyNetState(ifaces.length > 0, res.internet);
      if (state !== this.net) {
        const prev = this.net;
        this.net = state;
        if (state !== 'online') this.onlineRunCounted = false;
        log.info(`network: ${prev} -> ${state} [${ifaces.join(', ') || 'no interfaces'}]${res.captive ? ' (captive portal)' : ''}`);
        if (isMonitoring(this.phase) && this.log.isOpen) {
          this.log.append(state, {
            interfaces: ifaces,
            probes: res.probes.map((p) => ({ target: p.target, ok: p.ok, status: p.status, ms: p.ms, captive: p.captive })),
            hint: res.captive ? 'captive portal' : undefined,
          });
          if (state === 'limited' && inEnforcedWindow(this.schedule, this.serverNow())) this.limitedSeen = true;
          this.saveStats();
        }
      }
      if (res.serverReachable) void this.flushRealtime();
    } catch (err) {
      log.debug(`probe failed: ${errMsg(err)}`);
    } finally {
      this.probing = false;
    }
  }

  // ---------- delivery ----------

  /** Send unsent entries live (only possible while the server is reachable). */
  async flushRealtime() {
    if (this.flushing || !auth.state().signedIn || !this.log.current) return;
    this.flushing = true;
    try {
      const unsent = this.log.unsent();
      for (let i = 0; i < unsent.length; i += 500) {
        const batch = unsent.slice(i, i + 500);
        const ack = await api.request('/api/connectivity/events', ConnectivityAckSchema, {
          auth: true,
          body: { entries: batch },
          timeoutMs: 10_000,
        });
        this.log.markSent(batch[batch.length - 1]!.seq);
        if (ack.errors.length) log.warn(`server flagged events: ${ack.errors.slice(0, 3).join('; ')}`);
      }
    } catch (err) {
      log.debug(`realtime flush failed: ${errMsg(err)}`);
    } finally {
      this.flushing = false;
    }
  }

  /** Upload the full log (chain-verified by the server). */
  async uploadLog() {
    const meta = this.log.current;
    if (!meta || !auth.state().signedIn || this.log.pendingUpload === 0) return;
    this.lastUploadTry = Date.now();
    const entries = this.log.entries();
    if (entries.length === 0) return;
    try {
      const ack = await api.request('/api/connectivity/log', ConnectivityAckSchema, {
        auth: true,
        body: { logId: meta.logId, scheduleVersion: meta.scheduleVersion, entries },
        timeoutMs: 60_000,
      });
      this.log.markUploaded(entries[entries.length - 1]!.seq);
      log.info(`log uploaded (${entries.length} entries, chain ${ack.chainValid ? 'valid' : 'INVALID'})`);
      this.emitView();
    } catch (err) {
      log.debug(`log upload failed: ${errMsg(err)}`);
    }
  }

  async syncNow() {
    await this.syncSchedule();
    await this.probeNow();
    await this.flushRealtime();
    await this.uploadLog();
  }

  // ---------- view ----------

  private saveStats() {
    writeJson(paths.file('phase2-stats.json'), {
      logId: this.log.current?.logId,
      violations: this.violationCount,
      onlineMs: this.onlineMs,
      limited: this.limitedSeen,
    });
  }

  view(): Phase2View {
    const s = this.schedule;
    const now = this.serverNow();
    const start = s?.startAt ? Date.parse(s.startAt) : null;
    const end = s?.endAt ? Date.parse(s.endAt) : null;
    let compliance: Phase2View['compliance'] = 'pending';
    if (this.phase === 'active' || this.phase === 'ended') {
      compliance = this.violationCount > 0 ? 'violation' : this.limitedSeen && s?.mode === 'strict' ? 'warning' : 'compliant';
    }
    return {
      state: this.phase,
      startAt: s?.startAt ?? null,
      endAt: s?.endAt ?? null,
      mode: s?.mode ?? 'strict',
      graceSeconds: s?.graceSeconds ?? 0,
      msToStart: start !== null ? start - now : null,
      msToEnd: end !== null ? end - now : null,
      net: this.net,
      interfaces: this.ifaces,
      lastCheckAt: this.lastProbeAt ? new Date(this.lastProbeAt).toISOString() : null,
      compliance,
      violationCount: this.violationCount,
      onlineSeconds: Math.round(this.onlineMs / 1000),
      pendingUpload: this.log.pendingUpload,
      lastSyncAt: this.lastSyncAt ? new Date(this.lastSyncAt).toISOString() : null,
      safeToDisconnect: this.safeToDisconnect,
      projectDir: this.deps.projectDir(),
    };
  }

  private emitView() {
    this.deps.onView(this.view());
  }

  /** Last probe (diagnostics). */
  get lastProbeResult() {
    return this.lastProbe;
  }
}
