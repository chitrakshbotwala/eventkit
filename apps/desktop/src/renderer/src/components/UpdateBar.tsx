import { useState, type ReactNode } from 'react';
import type { UpdateView } from '@common/ipc';
import { ek } from '../lib/hooks';
import { Button, ProgressBar } from './ui';

/** Strip across the top of every screen while a newer EventKit is on its way or ready. */
export function UpdateBar({ update }: { update: UpdateView | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!update || !update.latest) return null;

  const restart = async () => {
    setBusy(true);
    setError(null);
    try {
      await ek.updates.install();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  let text: string;
  let action: ReactNode = null;
  if (update.state === 'downloading') {
    text = `Downloading EventKit ${update.latest}…`;
  } else if (update.state === 'ready') {
    text = update.paused
      ? `EventKit ${update.latest} is ready. ${update.paused}`
      : `EventKit ${update.latest} is ready to install.`;
    action = (
      <Button
        variant="primary"
        onClick={() => void restart()}
        disabled={busy || Boolean(update.paused)}
      >
        {busy ? 'Restarting…' : 'Restart to update'}
      </Button>
    );
  } else if (update.state === 'available' && update.mode === 'download' && update.downloadUrl) {
    const url = update.downloadUrl;
    text = `EventKit ${update.latest} is available.`;
    action = (
      <Button variant="primary" onClick={() => void ek.app.openExternal(url)}>
        Download
      </Button>
    );
  } else {
    return null;
  }

  return (
    <div
      role="status"
      className="flex items-center gap-4 border-b border-brand-100 bg-brand-50 px-6 py-2 text-sm text-brand-700 dark:border-brand-700/40 dark:bg-brand-700/20 dark:text-brand-100"
    >
      <div className="min-w-0 flex-1">
        <div>{error ?? text}</div>
        {update.state === 'downloading' && (
          <div className="mt-1 max-w-sm">
            <ProgressBar value={update.percent ?? 0} />
          </div>
        )}
      </div>
      {action}
    </div>
  );
}
