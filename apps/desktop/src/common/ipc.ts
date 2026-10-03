/**
 * Typed contract between the renderer (via preload) and the main process.
 * Only types live here: it is imported by main, preload and renderer.
 */
import type {
  AttendeeProfile,
  ComponentId,
  ComponentStatus,
  NetState,
  PhaseMode,
  PhaseState,
  SetupStep,
} from '@eventkit/shared';

export interface AppInfo {
  version: string;
  os: string;
  arch: string;
  osVersion: string;
  simulate: boolean;
  apiBaseUrl: string;
  packaged: boolean;
}

export interface AuthState {
  signedIn: boolean;
  profile: AttendeeProfile | null;
  /** Human-readable reason when the stored session could not be used. */
  error?: string;
}

export interface ComponentView {
  id: ComponentId;
  name: string;
  required: boolean;
  enabled: boolean;
  status: ComponentStatus;
  step?: SetupStep;
  version?: string;
  message?: string;
  error?: string;
  percent: number;
  bytesTotal?: number;
  bytesDone?: number;
  speedBps?: number;
  etaSeconds?: number;
}

export interface SetupSnapshot {
  running: boolean;
  /** true after a full run where every enabled component verified. */
  complete: boolean;
  overallPercent: number;
  currentComponent: ComponentId | null;
  components: ComponentView[];
  installRoot: string | null;
  manifestId: string | null;
  placeholderManifest: boolean;
  /** The organizers have not published the setup manifest yet; the app keeps checking. */
  waitingForManifest: boolean;
  /** Shown before an OS permission prompt is triggered. */
  elevationNotice: string | null;
  /** Shown near the start button (e.g. Android license consent). */
  consentNotice: string | null;
  error: string | null;
  lastVerifiedAt: string | null;
  doctorWarnings: string[];
  readiness: ReadinessView;
}

export interface ReadinessView {
  state: 'unknown' | 'not_ready' | 'submitting' | 'accepted' | 'rejected' | 'offline';
  reasons: string[];
  checkedAt: string | null;
}

export type QrView =
  | { visible: true; dataUrl: string; payload: string; expiresInMs: number; checkedIn: boolean }
  | { visible: false; reason: string; checkedIn: boolean };

export interface Phase2View {
  state: PhaseState;
  startAt: string | null;
  endAt: string | null;
  mode: PhaseMode;
  graceSeconds: number;
  /** ms until start (negative once started). */
  msToStart: number | null;
  msToEnd: number | null;
  net: NetState;
  interfaces: string[];
  lastCheckAt: string | null;
  compliance: 'compliant' | 'violation' | 'warning' | 'pending';
  violationCount: number;
  onlineSeconds: number;
  pendingUpload: number;
  lastSyncAt: string | null;
  safeToDisconnect: boolean;
  projectDir: string | null;
}

export interface UpdateView {
  /**
   * install: this build downloads and installs updates itself (Windows, AppImage, deb, rpm,
   * pacman). download: it can only point to the download page (unsigned macOS builds).
   * off: development builds, or an install EventKit can't update.
   */
  mode: 'install' | 'download' | 'off';
  current: string;
  state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error';
  /** The newer version, once one is found. */
  latest: string | null;
  /** Download progress, 0-100. */
  percent: number | null;
  error: string | null;
  checkedAt: string | null;
  /** Set while updates wait (the offline phase). */
  paused: string | null;
  /** Release page for downloading by hand. */
  downloadUrl: string | null;
}

export interface LogLine {
  t: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  msg: string;
}

/** Methods exposed on `window.eventkit`. */
export interface EventKitApi {
  app: {
    info(): Promise<AppInfo>;
    openExternal(url: string): Promise<void>;
  };
  auth: {
    state(): Promise<AuthState>;
    /** Opens the system browser; resolves once the attendee is signed in. */
    signInWithGoogle(): Promise<AuthState>;
    cancelSignIn(): Promise<void>;
    reopenSignIn(): Promise<void>;
    signOut(): Promise<void>;
    refresh(): Promise<AuthState>;
  };
  setup: {
    snapshot(): Promise<SetupSnapshot>;
    start(): Promise<void>;
    retry(componentId?: ComponentId): Promise<void>;
    cancel(): Promise<void>;
    reverify(): Promise<void>;
    repair(): Promise<void>;
    copyDiagnostics(): Promise<void>;
  };
  qr: {
    current(): Promise<QrView>;
  };
  phase2: {
    state(): Promise<Phase2View>;
    sync(): Promise<void>;
  };
  tools: {
    openVsCode(): Promise<void>;
    openProjectFolder(): Promise<void>;
    runDoctor(): Promise<string>;
  };
  logs: {
    recent(): Promise<LogLine[]>;
    openFolder(): Promise<void>;
  };
  updates: {
    state(): Promise<UpdateView>;
    /** Check the release feed now. */
    check(): Promise<UpdateView>;
    /** Quit, install the downloaded update and start the new version. */
    install(): Promise<void>;
  };
  on<E extends keyof EventMap>(event: E, cb: (payload: EventMap[E]) => void): () => void;
}

export interface EventMap {
  'auth:changed': AuthState;
  'setup:snapshot': SetupSnapshot;
  'log:line': LogLine;
  'qr:changed': QrView;
  'phase2:changed': Phase2View;
  'update:changed': UpdateView;
}

export const EVENT_NAMES: ReadonlyArray<keyof EventMap> = [
  'auth:changed',
  'setup:snapshot',
  'log:line',
  'qr:changed',
  'phase2:changed',
  'update:changed',
];

/** Invoke channel names (renderer -> main). */
export const CHANNELS = {
  appInfo: 'app:info',
  openExternal: 'app:openExternal',
  authState: 'auth:state',
  signInWithGoogle: 'auth:signInWithGoogle',
  cancelSignIn: 'auth:cancelSignIn',
  reopenSignIn: 'auth:reopenSignIn',
  signOut: 'auth:signOut',
  authRefresh: 'auth:refresh',
  setupSnapshot: 'setup:snapshot',
  setupStart: 'setup:start',
  setupRetry: 'setup:retry',
  setupCancel: 'setup:cancel',
  setupReverify: 'setup:reverify',
  setupRepair: 'setup:repair',
  copyDiagnostics: 'setup:copyDiagnostics',
  qrCurrent: 'qr:current',
  phase2State: 'phase2:state',
  phase2Sync: 'phase2:sync',
  openVsCode: 'tools:openVsCode',
  openProjectFolder: 'tools:openProjectFolder',
  runDoctor: 'tools:runDoctor',
  logsRecent: 'logs:recent',
  logsOpenFolder: 'logs:openFolder',
  updateState: 'update:state',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];

/** Error shape transported across IPC (Error objects lose fields). */
export interface IpcErrorPayload {
  code: string;
  message: string;
}
