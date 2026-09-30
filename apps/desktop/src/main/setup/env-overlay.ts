import { delimiter } from 'node:path';

export interface DesiredEnv {
  /** Directories to put in front of PATH, highest priority first. */
  path: string[];
  vars: Record<string, string>;
}

/**
 * The environment our toolchain needs. Applied immediately to child processes
 * we spawn (so later steps see earlier installs) and persisted to the user's
 * shell/registry by env-persist.
 */
export class EnvOverlay {
  private desired: DesiredEnv;
  /** In-process only (never persisted), e.g. proxy settings for child tools. */
  private session: Record<string, string> = {};

  constructor(initial?: DesiredEnv) {
    this.desired = initial ? structuredClone(initial) : { path: [], vars: {} };
  }

  addPath(dir: string) {
    const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
    if (!this.desired.path.some((p) => norm(p) === norm(dir))) this.desired.path.push(dir);
  }

  setVar(name: string, value: string) {
    this.desired.vars[name] = value;
  }

  setSessionVar(name: string, value: string) {
    this.session[name] = value;
  }

  unsetVar(name: string) {
    delete this.desired.vars[name];
  }

  toJSON(): DesiredEnv {
    return structuredClone(this.desired);
  }

  /** process.env merged with our PATH entries and variables. */
  childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, ...this.session, ...this.desired.vars };
    // Never leak Electron runtime variables into child tools (VS Code is an Electron app).
    for (const k of Object.keys(env)) {
      if (/^(ELECTRON_|ORIGINAL_XDG_|CHROME_CRASHPAD)/.test(k) || k === 'NODE_OPTIONS')
        delete env[k];
    }
    const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    const current = env[pathKey] ?? '';
    env[pathKey] = [...this.desired.path, current].filter(Boolean).join(delimiter);
    // Keep tools quiet and non-interactive.
    env['FLUTTER_SUPPRESS_ANALYTICS'] = 'true';
    env['DART_SUPPRESS_ANALYTICS'] = 'true';
    return env;
  }
}
