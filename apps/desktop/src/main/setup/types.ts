import type {
  Arch,
  Artifact,
  ComponentId,
  ComponentStatus,
  DoctorSummary,
  ManifestComponent,
  ManifestPayload,
  Platform,
  SetupStep,
} from '@eventkit/shared';
import type { DoctorEvaluation } from '@eventkit/shared';
import type { ScopedLogger } from '../logger';
import type { EnvOverlay } from './env-overlay';
import type { RunOptions, RunResult } from './exec';

export interface Detection {
  installed: boolean;
  version?: string;
  path?: string;
  detail?: string;
}

export interface VerifyResult {
  ok: boolean;
  version?: string;
  detail?: string;
}

/** Facts discovered by components and shared with later ones (persisted). */
export interface Facts {
  gitExe?: string;
  flutterRoot?: string;
  javaHome?: string;
  androidSdk?: string;
  chromeExe?: string;
  vscodeCli?: string;
  projectDir?: string;
  packageManager?: 'apt' | 'dnf' | 'pacman' | 'zypper';
  proxy?: string;
  doctorOutput?: string;
  doctor?: DoctorSummary;
  doctorEval?: DoctorEvaluation;
  flutterVersion?: string;
  devtoolsVersion?: string;
  /** Simulate mode: components "installed" so far, with versions. */
  simulated?: Partial<Record<ComponentId, string>>;
}

export interface InstallDirs {
  root: string;
  flutter: string;
  jdk: string;
  androidSdk: string;
  vscode: string;
  downloads: string;
  staging: string;
  projects: string;
}

export interface ToolRunner {
  /** Run an executable (or .bat/.cmd on Windows) with an argument array. */
  run(file: string, args: string[], opts?: RunOptions): Promise<RunResult>;
}

export interface ComponentContext {
  manifest: ManifestPayload;
  platform: Platform;
  arch: Arch;
  dirs: InstallDirs;
  facts: Facts;
  env: EnvOverlay;
  log: ScopedLogger;
  exec: ToolRunner;
  signal: AbortSignal;
  simulate: boolean;
  /** Periodic re-verification: prefer cheap checks over launching heavy tools. */
  quick: boolean;
  /** Report the current step (shown in the checklist). */
  step(step: SetupStep, message?: string): void;
  /** Report progress within the current component (0-100) and/or a message. */
  progress(p: { percent?: number; message?: string }): void;
  /** Download (or await the prefetched download of) an artifact; returns the local file. */
  download(artifact: Artifact): Promise<string>;
  /** Explain an upcoming OS permission prompt in the UI, then wait briefly. */
  elevate(reason: string): Promise<void>;
  /** Persist facts / state now. */
  save(): void;
}

export interface ComponentRunner<C extends ManifestComponent = ManifestComponent> {
  id: C['id'];
  /** Relative share of the overall progress bar. */
  weight: number;
  /** Components that must be verified before install can start. */
  dependsOn(c: C, m: ManifestPayload): ComponentId[];
  /** Artifacts to prefetch when this component needs installing. */
  artifacts(c: C, ctx: ComponentContext): Artifact[];
  detect(c: C, ctx: ComponentContext): Promise<Detection>;
  install(c: C, ctx: ComponentContext): Promise<void>;
  verify(c: C, ctx: ComponentContext): Promise<VerifyResult>;
}

export type AnyRunner = ComponentRunner<ManifestComponent>;

export interface ComponentState {
  status: ComponentStatus;
  step?: SetupStep;
  version?: string;
  message?: string;
  error?: string;
  attempts: number;
  updatedAt: string;
}

export interface PersistedSetupState {
  schema: 1;
  installRoot: string | null;
  manifestId: string | null;
  components: Partial<Record<ComponentId, ComponentState>>;
  facts: Facts;
  complete: boolean;
  lastVerifiedAt: string | null;
}

/** Raised for user-actionable failures (shown verbatim). */
export class SetupError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'SetupError';
  }
}
