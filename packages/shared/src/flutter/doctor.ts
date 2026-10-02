import type {
  DoctorCategory,
  DoctorCategoryKey,
  DoctorCategoryStatus,
  DoctorSummary,
} from '../schemas/setup';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

const STATUS_MARKS: Record<string, DoctorCategoryStatus> = {
  '✓': 'ok',
  '√': 'ok',
  '✔': 'ok',
  '!': 'partial',
  '✗': 'missing',
  '✘': 'missing',
  X: 'missing',
  x: 'missing',
  '☠': 'crash',
  '-': 'unknown',
};

const CATEGORY_PATTERNS: Array<[RegExp, DoctorCategoryKey]> = [
  [/^Flutter\b/, 'flutter'],
  [/^Windows Version\b/, 'windows'],
  [/^Android toolchain\b/, 'android'],
  [/^Xcode\b/, 'xcode'],
  [/^Chrome\b/, 'chrome'],
  [/^Visual Studio(?! Code)\b/, 'visual-studio'],
  [/^Android Studio\b/, 'android-studio'],
  [/^VS Code\b/, 'vscode'],
  [/^IntelliJ\b/, 'intellij'],
  [/^Linux toolchain\b/, 'linux-toolchain'],
  [/^Connected device\b/, 'devices'],
  [/^Network resources\b/, 'network'],
  [/^Proxy Configuration\b/, 'proxy'],
];

function categoryKey(title: string): DoctorCategoryKey {
  for (const [re, key] of CATEGORY_PATTERNS) if (re.test(title)) return key;
  return 'other';
}

/**
 * Parse `flutter doctor -v` output. Handles unicode and ASCII fallback markers
 * ([✓]/[√], [✗]/[X], [!], [☠]), ANSI colors, CRLF, `-v` timing suffixes and
 * wrapped continuation lines.
 */
export function parseFlutterDoctor(output: string): DoctorSummary {
  const lines = output.replace(ANSI_RE, '').replace(/\r\n?/g, '\n').split('\n');
  const categories: DoctorCategory[] = [];
  let current: DoctorCategory | null = null;
  let lastList: string[] | null = null;
  let flutterVersion: string | undefined;
  let channel: string | undefined;
  let dartVersion: string | undefined;

  for (const raw of lines) {
    const header = /^\[(.)\]\s+(.+?)\s*$/.exec(raw);
    if (header) {
      const mark = header[1]!;
      const title = header[2]!.replace(/\s*\[[\d.,]+\s*m?s\]\s*$/, '');
      current = {
        key: categoryKey(title),
        title,
        status: STATUS_MARKS[mark] ?? 'unknown',
        errors: [],
        warnings: [],
      };
      categories.push(current);
      lastList = null;
      if (current.key === 'flutter') {
        const m = /Channel\s+([\w-]+),\s*v?(\d+\.\d+\.\d+[\w.+-]*)/.exec(title);
        if (m) {
          channel = m[1];
          flutterVersion = m[2];
        }
      }
      continue;
    }
    if (!current) continue;
    if (raw.trim() === '') {
      lastList = null;
      continue;
    }

    const item = /^\s{2,}([•*✗✘X!])\s+(.*)$/.exec(raw);
    if (item) {
      const marker = item[1]!;
      const text = item[2]!.trim();
      if (marker === '✗' || marker === '✘' || marker === 'X') {
        current.errors.push(text);
        lastList = current.errors;
      } else if (marker === '!') {
        current.warnings.push(text);
        lastList = current.warnings;
      } else {
        lastList = null;
        if (current.key === 'flutter') {
          const fv =
            /^Flutter version\s+v?(\d+\.\d+\.\d+[\w.+-]*)(?:\s+on channel\s+([\w-]+))?/.exec(text);
          if (fv) {
            flutterVersion ??= fv[1];
            channel ??= fv[2];
          }
          const dv = /^Dart version\s+(\d+\.\d+\.\d+[\w.+-]*)/.exec(text);
          if (dv) dartVersion = dv[1];
        }
      }
      continue;
    }

    // Continuation of a wrapped error/warning line.
    if (/^\s{4,}\S/.test(raw) && lastList && lastList.length > 0) {
      lastList[lastList.length - 1] += ` ${raw.trim()}`;
    }
  }

  return { flutterVersion, channel, dartVersion, categories };
}

export interface DoctorEvaluationOptions {
  androidRequired: boolean;
  /** Whether our own VS Code component verified VS Code (doctor omits it when not found). */
  vscodeVerifiedLocally: boolean;
  /**
   * Whether our own Android component found the accepted SDK license. Flutter before 3.47
   * can't read the license status from Android cmdline-tools 23+ (which answers
   * `--licenses` with "no longer needed") and reports it as unknown; with the license
   * verified locally, that alone is only a warning.
   */
  androidLicensesVerifiedLocally?: boolean;
}

const LICENSE_STATUS_UNKNOWN = /license status unknown/i;

export interface DoctorEvaluation {
  passed: boolean;
  failures: string[];
  warnings: string[];
}

const RANK: Record<DoctorCategoryStatus, number> = {
  ok: 4,
  partial: 3,
  unknown: 2,
  missing: 1,
  crash: 0,
};

const LABELS: Partial<Record<DoctorCategoryKey, string>> = {
  flutter: 'Flutter',
  android: 'Android toolchain',
  chrome: 'Chrome',
  vscode: 'VS Code',
};

function best(categories: DoctorCategory[], key: DoctorCategoryKey): DoctorCategory | undefined {
  return categories.filter((c) => c.key === key).sort((a, b) => RANK[b.status] - RANK[a.status])[0];
}

function describe(c: DoctorCategory): string {
  const detail = [...c.errors, ...c.warnings][0];
  return detail ? `${c.title}: ${detail}` : `${c.title} (${c.status})`;
}

/**
 * Apply the gating policy:
 * REQUIRED: Flutter, Android toolchain (if enabled), Chrome, VS Code.
 * NON-BLOCKING: Visual Studio, Xcode, Android Studio, devices, network resources, etc.
 */
export function evaluateDoctor(
  summary: DoctorSummary,
  opts: DoctorEvaluationOptions,
): DoctorEvaluation {
  const failures: string[] = [];
  const warnings: string[] = [];
  const cats = summary.categories;

  const flutter = best(cats, 'flutter');
  if (!flutter) failures.push('Flutter: not reported by flutter doctor');
  else if (flutter.status === 'ok') {
    /* pass */
  } else if (flutter.status === 'partial' && flutter.errors.length === 0) {
    warnings.push(describe(flutter));
  } else failures.push(describe(flutter));

  const strictRequired: DoctorCategoryKey[] = ['chrome'];
  if (opts.androidRequired) strictRequired.unshift('android');
  for (const key of strictRequired) {
    const c = best(cats, key);
    if (!c) failures.push(`${LABELS[key]}: not reported by flutter doctor`);
    else if (c.status === 'ok') {
      /* pass */
    } else if (
      key === 'android' &&
      opts.androidLicensesVerifiedLocally &&
      c.status === 'partial' &&
      [...c.errors, ...c.warnings].length > 0 &&
      [...c.errors, ...c.warnings].every((issue) => LICENSE_STATUS_UNKNOWN.test(issue))
    ) {
      warnings.push(describe(c));
    } else failures.push(describe(c));
  }

  const vscode = best(cats, 'vscode');
  if (!vscode) {
    if (opts.vscodeVerifiedLocally)
      warnings.push('VS Code: not detected by flutter doctor (verified locally)');
    else failures.push('VS Code: not installed');
  } else if (vscode.status === 'ok') {
    /* pass */
  } else if (vscode.status === 'partial') {
    warnings.push(describe(vscode));
  } else failures.push(describe(vscode));

  const handled = new Set<DoctorCategoryKey>(['flutter', 'chrome', 'vscode']);
  if (opts.androidRequired) handled.add('android');
  for (const c of cats) {
    if (handled.has(c.key) || c.status === 'ok') continue;
    warnings.push(describe(c));
  }

  return { passed: failures.length === 0, failures, warnings };
}
