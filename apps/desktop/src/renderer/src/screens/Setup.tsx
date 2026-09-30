import { useState } from 'react';
import type { ComponentView, SetupSnapshot } from '@common/ipc';
import { LogDrawer } from '../components/LogDrawer';
import { Badge, Banner, Button, Card, ProgressBar, Spinner } from '../components/ui';
import { ek, formatBytes, formatEta } from '../lib/hooks';

function StatusIcon({ c }: { c: ComponentView }) {
  const base = 'grid h-7 w-7 shrink-0 place-items-center rounded-full text-sm font-bold';
  switch (c.status) {
    case 'verified':
      return (
        <span
          className={`${base} bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300`}
          aria-label="done"
        >
          ✓
        </span>
      );
    case 'failed':
      return (
        <span
          className={`${base} bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300`}
          aria-label="failed"
        >
          !
        </span>
      );
    case 'running':
      return (
        <span
          className={`${base} bg-brand-100 text-brand-700 dark:bg-brand-700/40 dark:text-brand-100`}
          aria-label="running"
        >
          <Spinner />
        </span>
      );
    case 'disabled':
    case 'skipped':
      return (
        <span
          className={`${base} bg-slate-100 text-slate-400 dark:bg-slate-800`}
          aria-label="skipped"
        >
          –
        </span>
      );
    default:
      return (
        <span
          className={`${base} bg-slate-100 text-slate-500 dark:bg-slate-800`}
          aria-label="pending"
        >
          •
        </span>
      );
  }
}

function ComponentRow({
  c,
  onRetry,
  busy,
}: {
  c: ComponentView;
  onRetry: () => void;
  busy: boolean;
}) {
  const downloading =
    c.bytesTotal !== undefined && c.bytesDone !== undefined && c.bytesDone < c.bytesTotal;
  return (
    <li className="flex items-start gap-3 py-3">
      <StatusIcon c={c} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{c.name}</span>
          {c.version && <Badge tone="gray">{c.version}</Badge>}
          {!c.required && c.enabled && <Badge tone="blue">optional</Badge>}
          {c.status === 'disabled' && <Badge>not needed</Badge>}
        </div>
        <div className="mt-0.5 text-xs text-slate-500">
          {c.status === 'failed' ? (
            <span className="selectable text-red-600 dark:text-red-400">{c.error ?? 'Failed'}</span>
          ) : (
            <>
              {c.step && c.status === 'running' && (
                <span className="mr-2 uppercase tracking-wide">{c.step.replace('-', ' ')}</span>
              )}
              {c.message}
              {downloading && (
                <span className="ml-2 tabular-nums">
                  {formatBytes(c.bytesDone)} / {formatBytes(c.bytesTotal)}
                  {c.speedBps ? ` · ${formatBytes(c.speedBps)}/s` : ''}
                  {c.etaSeconds !== undefined ? ` · ${formatEta(c.etaSeconds)} left` : ''}
                </span>
              )}
            </>
          )}
        </div>
        {(c.status === 'running' || (c.status === 'pending' && c.percent > 0)) && (
          <div className="mt-2">
            <ProgressBar
              value={c.percent}
              indeterminate={c.status === 'running' && c.percent === 0}
            />
          </div>
        )}
      </div>
      {c.status === 'failed' && (
        <Button onClick={onRetry} disabled={busy}>
          Retry
        </Button>
      )}
    </li>
  );
}

export function Setup({ snap, onDone }: { snap: SetupSnapshot | null; onDone: () => void }) {
  const [logsOpen, setLogsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!snap) return null;

  const started = snap.components.some((c) => c.status !== 'pending' && c.status !== 'disabled');
  const failed = snap.components.some((c) => c.status === 'failed');

  const copyDiagnostics = async () => {
    await ek.setup.copyDiagnostics();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      {snap.placeholderManifest && (
        <Banner tone="warn" title="Development manifest">
          The server is serving placeholder artifacts. Only simulate mode can install them.
        </Banner>
      )}

      <Card>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-xl font-semibold">
              {snap.complete
                ? 'Your laptop is ready'
                : snap.running
                  ? 'Setting up your laptop…'
                  : 'Set up your laptop'}
            </h1>
            <p className="mt-1 text-sm text-slate-500">
              {snap.complete
                ? 'Everything is installed and verified.'
                : 'One click installs Git, the Flutter SDK, Java, the Android SDK, Chrome and VS Code. Keep the laptop plugged in and online.'}
            </p>
          </div>
          {snap.complete ? (
            <Button variant="primary" className="px-6 py-3 text-base" onClick={onDone}>
              Show my QR code
            </Button>
          ) : snap.running ? (
            <Button variant="secondary" onClick={() => void ek.setup.cancel()}>
              Cancel
            </Button>
          ) : (
            <Button
              variant="primary"
              className="px-6 py-3 text-base"
              onClick={() => void ek.setup.start()}
            >
              {started ? 'Continue setup' : 'Set up my laptop'}
            </Button>
          )}
        </div>
        {snap.consentNotice && !snap.complete && (
          <p className="mt-4 text-xs text-slate-500">{snap.consentNotice}</p>
        )}
        <div className="mt-5">
          <div className="mb-1 flex justify-between text-xs text-slate-500">
            <span>Overall progress</span>
            <span className="tabular-nums">{Math.round(snap.overallPercent)}%</span>
          </div>
          <ProgressBar
            value={snap.overallPercent}
            tone={snap.complete ? 'green' : failed ? 'red' : 'brand'}
          />
        </div>
      </Card>

      {snap.elevationNotice && (
        <Banner tone="info" title="Permission needed">
          {snap.elevationNotice}
        </Banner>
      )}
      {snap.error && !snap.running && (
        <Banner tone="error" title="Setup needs attention">
          <span className="selectable">{snap.error}</span>
        </Banner>
      )}

      <Card className="p-0">
        <ul className="divide-y divide-slate-100 px-5 dark:divide-slate-800">
          {snap.components.map((c) => (
            <ComponentRow
              key={c.id}
              c={c}
              busy={snap.running}
              onRetry={() => void ek.setup.retry(c.id)}
            />
          ))}
          {snap.components.length === 0 && (
            <li className="py-6 text-center text-sm text-slate-500">Loading setup plan…</li>
          )}
        </ul>
      </Card>

      {snap.doctorWarnings.length > 0 && (
        <Card>
          <div className="mb-2 text-sm font-medium">
            Not required for this event (warnings only)
          </div>
          <ul className="list-disc space-y-1 pl-5 text-xs text-slate-500">
            {snap.doctorWarnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setLogsOpen((o) => !o)}>
          {logsOpen ? 'Hide log' : 'Show live log'}
        </Button>
        <Button onClick={() => void copyDiagnostics()}>
          {copied ? 'Copied!' : 'Copy diagnostics'}
        </Button>
        {failed && !snap.running && (
          <Button variant="primary" onClick={() => void ek.setup.retry()}>
            Retry failed steps
          </Button>
        )}
        {snap.installRoot && (
          <span className="self-center text-xs text-slate-500">
            Install folder: {snap.installRoot}
          </span>
        )}
      </div>

      <LogDrawer open={logsOpen} onClose={() => setLogsOpen(false)} />
    </div>
  );
}
