import { useState } from 'react';
import type { AppInfo, SetupSnapshot, UpdateView } from '@common/ipc';
import { LogDrawer } from '../components/LogDrawer';
import { Banner, Button, Card, Spinner } from '../components/ui';
import { ek, useAction } from '../lib/hooks';

function updateStatus(u: UpdateView): string {
  if (u.mode === 'off') return 'Updates are off in this build.';
  if (u.paused && u.state !== 'ready') return u.paused;
  switch (u.state) {
    case 'checking':
      return 'Checking for updates…';
    case 'up-to-date':
      return `Up to date${u.checkedAt ? ` (checked at ${new Date(u.checkedAt).toLocaleTimeString()})` : ''}.`;
    case 'available':
      return `Version ${u.latest} is available.`;
    case 'downloading':
      return `Downloading version ${u.latest} (${u.percent ?? 0}%)…`;
    case 'ready':
      return u.paused
        ? `Version ${u.latest} is ready. ${u.paused}`
        : `Version ${u.latest} is ready to install.`;
    case 'error':
      return `Update check failed: ${u.error}`;
    default:
      return 'EventKit checks for updates automatically every few hours.';
  }
}

export function Settings({
  info,
  setup,
  update,
  onGoSetup,
}: {
  info: AppInfo | null;
  setup: SetupSnapshot | null;
  update: UpdateView | null;
  onGoSetup: () => void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
  const checkUpdates = useAction(ek.updates.check);
  const installUpdate = useAction(ek.updates.install);
  const reverify = useAction(ek.setup.reverify);
  const signOut = useAction(ek.auth.signOut);
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <Card>
        <h2 className="text-lg font-semibold">Toolchain</h2>
        <p className="mt-1 text-sm text-slate-500">
          {setup?.lastVerifiedAt
            ? `Last verified ${new Date(setup.lastVerifiedAt).toLocaleString()}.`
            : 'Not verified yet.'}
          {setup?.installRoot && ` Installed in ${setup.installRoot}.`}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => void reverify.run()} disabled={reverify.busy || setup?.running}>
            {reverify.busy && <Spinner />} Re-verify now
          </Button>
          <Button
            onClick={() => {
              void ek.setup.repair();
              onGoSetup();
            }}
            disabled={setup?.running}
          >
            Repair installation
          </Button>
          <Button onClick={() => setLogsOpen(true)}>View logs</Button>
          <Button onClick={() => void ek.logs.openFolder()}>Open log folder</Button>
        </div>
        {reverify.error && (
          <div className="mt-3">
            <Banner tone="error">{reverify.error}</Banner>
          </div>
        )}
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">About</h2>
        <dl className="mt-3 grid grid-cols-[140px_1fr] gap-y-1 text-sm">
          <dt className="text-slate-500">Version</dt>
          <dd>{info?.version}</dd>
          {update && (
            <>
              <dt className="text-slate-500">Updates</dt>
              <dd>
                <div>{updateStatus(update)}</div>
                {update.mode !== 'off' && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {update.state === 'ready' ? (
                      <Button
                        variant="primary"
                        onClick={() => void installUpdate.run()}
                        disabled={installUpdate.busy || Boolean(update.paused)}
                      >
                        {installUpdate.busy && <Spinner />} Restart to update
                      </Button>
                    ) : update.state === 'available' &&
                      update.mode === 'download' &&
                      update.downloadUrl ? (
                      <Button
                        variant="primary"
                        onClick={() => void ek.app.openExternal(update.downloadUrl!)}
                      >
                        Download version {update.latest}
                      </Button>
                    ) : (
                      <Button
                        onClick={() => void checkUpdates.run()}
                        disabled={
                          checkUpdates.busy ||
                          update.state === 'checking' ||
                          update.state === 'downloading'
                        }
                      >
                        {(checkUpdates.busy || update.state === 'checking') && <Spinner />} Check
                        for updates
                      </Button>
                    )}
                  </div>
                )}
                {(checkUpdates.error ?? installUpdate.error) && (
                  <div className="mt-2 text-red-600 dark:text-red-400">
                    {checkUpdates.error ?? installUpdate.error}
                  </div>
                )}
              </dd>
            </>
          )}
          <dt className="text-slate-500">Platform</dt>
          <dd>
            {info?.os} / {info?.arch} ({info?.osVersion})
          </dd>
          <dt className="text-slate-500">Server</dt>
          <dd className="selectable">{info?.apiBaseUrl}</dd>
          {info?.simulate && (
            <>
              <dt className="text-slate-500">Mode</dt>
              <dd>Simulate (nothing is really installed)</dd>
            </>
          )}
        </dl>
      </Card>

      <Card>
        <h2 className="text-lg font-semibold">Account</h2>
        {confirmSignOut ? (
          <div className="mt-3 space-y-3">
            <Banner tone="warn">
              Signing out removes your QR code from this laptop. You will need a new email code to
              sign back in.
            </Banner>
            <div className="flex gap-2">
              <Button variant="danger" onClick={() => void signOut.run()} disabled={signOut.busy}>
                Sign out
              </Button>
              <Button onClick={() => setConfirmSignOut(false)}>Cancel</Button>
            </div>
          </div>
        ) : (
          <Button className="mt-3" onClick={() => setConfirmSignOut(true)}>
            Sign out
          </Button>
        )}
      </Card>

      <LogDrawer open={logsOpen} onClose={() => setLogsOpen(false)} />
    </div>
  );
}
