import { useState } from 'react';
import type { AppInfo, SetupSnapshot } from '@common/ipc';
import { LogDrawer } from '../components/LogDrawer';
import { Banner, Button, Card, Spinner } from '../components/ui';
import { ek, useAction } from '../lib/hooks';

export function Settings({
  info,
  setup,
  onGoSetup,
}: {
  info: AppInfo | null;
  setup: SetupSnapshot | null;
  onGoSetup: () => void;
}) {
  const [logsOpen, setLogsOpen] = useState(false);
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
