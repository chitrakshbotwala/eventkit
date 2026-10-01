import { spawn } from 'node:child_process';
import { join } from 'node:path';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Text written to stdin, then stdin is closed (unless `respond` is set). */
  input?: string;
  /** Called for every output line (split on \n and \r). */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Interactive prompts: return text to write to stdin for an output chunk. */
  respond?: (chunk: string) => string | null;
  signal?: AbortSignal;
  /** Resolve instead of throwing on a non-zero exit code. */
  allowFailure?: boolean;
  /** Detach and do not wait (used for launching GUI apps). */
  detached?: boolean;
}

export interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export class ExecError extends Error {
  constructor(
    readonly file: string,
    readonly args: string[],
    readonly result: RunResult,
  ) {
    const tail = (result.stderr || result.stdout).trim().split(/\r?\n/).slice(-5).join(' | ');
    super(
      `${basename(file)} ${result.timedOut ? 'timed out' : `exited with ${result.code ?? result.signal}`}${tail ? `: ${tail}` : ''}`,
    );
    this.name = 'ExecError';
  }
}

const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;
const MAX_CAPTURE = 4 * 1024 * 1024;

/** cmd.exe metacharacters that could break out of a quoted batch invocation. */
const CMD_UNSAFE = /[&|<>^%!"\r\n`]/;

export function quoteCmdArg(arg: string): string {
  if (CMD_UNSAFE.test(arg))
    throw new Error(`refusing unsafe argument for cmd.exe: ${JSON.stringify(arg)}`);
  // cmd treats space, ; , = as separators for batch arguments: quote those.
  return arg === '' || /[\s;,=()]/.test(arg) ? `"${arg}"` : arg;
}

/** Build the verbatim command line for running a .bat/.cmd via cmd.exe. */
export function batchCommandLine(file: string, args: string[]): string {
  return `"${[quoteCmdArg(file), ...args.map(quoteCmdArg)].join(' ')}"`;
}

function isBatch(file: string) {
  return process.platform === 'win32' && /\.(bat|cmd)$/i.test(file);
}

function comspec() {
  return (
    process.env['ComSpec'] ??
    join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe')
  );
}

/** Kill a process and its children. */
export function killTree(pid: number) {
  try {
    if (process.platform === 'win32') {
      spawn(
        join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/pid', String(pid), '/T', '/F'],
        {
          windowsHide: true,
          stdio: 'ignore',
        },
      );
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Spawn a process with an argument array (never a shell string).
 * Windows .bat/.cmd files are run through `cmd.exe /d /s /c` with validated, quoted args,
 * because Node refuses to spawn them directly (CVE-2024-27980).
 */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const batch = isBatch(file);
    const cmd = batch ? comspec() : file;
    const cmdArgs = batch ? ['/d', '/s', '/c', batchCommandLine(file, args)] : args;
    let child;
    try {
      child = spawn(cmd, cmdArgs, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: batch,
        detached: opts.detached ?? process.platform !== 'win32',
        stdio: opts.detached ? 'ignore' : ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    if (opts.detached) {
      child.unref();
      child.once('error', reject);
      child.once('spawn', () =>
        resolve({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false }),
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const partial = { stdout: '', stderr: '' };

    const onData = (stream: 'stdout' | 'stderr') => (buf: Buffer) => {
      const text = buf.toString('utf8');
      if (stream === 'stdout' && stdout.length < MAX_CAPTURE) stdout += text;
      if (stream === 'stderr' && stderr.length < MAX_CAPTURE) stderr += text;
      if (opts.respond && child.stdin?.writable) {
        const reply = opts.respond(text);
        if (reply !== null) child.stdin.write(reply);
      }
      if (opts.onLine) {
        const combined = partial[stream] + text;
        const lines = combined.split(/\r\n|\n|\r/);
        partial[stream] = lines.pop() ?? '';
        for (const l of lines) if (l.trim()) opts.onLine(l, stream);
      }
    };
    child.stdout?.on('data', onData('stdout'));
    child.stderr?.on('data', onData('stderr'));
    child.stdin?.on('error', () => undefined);
    if (opts.input !== undefined) child.stdin?.write(opts.input);
    if (!opts.respond) child.stdin?.end();

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          if (child.pid) killTree(child.pid);
        }, opts.timeoutMs)
      : null;
    const onAbort = () => {
      if (child.pid) killTree(child.pid);
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.once('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      for (const s of ['stdout', 'stderr'] as const) {
        if (partial[s].trim() && opts.onLine) opts.onLine(partial[s], s);
      }
      const result: RunResult = { code, signal, stdout, stderr, timedOut };
      if (opts.signal?.aborted) {
        reject(new Error('cancelled'));
      } else if ((code !== 0 || timedOut) && !opts.allowFailure) {
        reject(new ExecError(file, args, result));
      } else {
        resolve(result);
      }
    });
  });
}

/** Look up an executable on PATH (no shell). */
export async function which(
  name: string,
  envPath = process.env['PATH'] ?? '',
): Promise<string | null> {
  const { access } = await import('node:fs/promises');
  const { constants } = await import('node:fs');
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of envPath.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir.replace(/^"|"$/g, ''), name + ext);
      try {
        await access(p, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return p;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}
