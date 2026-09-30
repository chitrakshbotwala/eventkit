import { useEffect, useState } from 'react';
import type { AppInfo, AuthState, SetupSnapshot } from '@common/ipc';
import { Badge, Banner, Button, Card } from '../components/ui';
import { useQr } from '../lib/hooks';

function Countdown({ ms }: { ms: number }) {
  const [left, setLeft] = useState(ms);
  useEffect(() => {
    setLeft(ms);
    const start = Date.now();
    const t = setInterval(() => setLeft(Math.max(0, ms - (Date.now() - start))), 250);
    return () => clearInterval(t);
  }, [ms]);
  const pct = (left / 60_000) * 100;
  return (
    <div className="mt-3 w-full">
      <div className="h-1 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className="h-full bg-brand-500 transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-center text-xs text-slate-500">
        Refreshes in {Math.ceil(left / 1000)}s
      </div>
    </div>
  );
}

export function Profile({
  auth,
  setup,
  info,
  onGoSetup,
}: {
  auth: AuthState;
  setup: SetupSnapshot | null;
  info: AppInfo | null;
  onGoSetup: () => void;
}) {
  const qr = useQr(true);
  const p = auth.profile;
  const verified = setup?.components.filter((c) => c.status === 'verified').length ?? 0;
  const enabled = setup?.components.filter((c) => c.enabled).length ?? 0;
  const checkedIn = qr?.checkedIn || Boolean(p?.checkedInAt);

  return (
    <div className="mx-auto grid max-w-4xl gap-5 p-6 md:grid-cols-[1fr_360px]">
      <Card>
        <h1 className="text-xl font-semibold">{p?.name}</h1>
        <div className="text-sm text-slate-500">{p?.email}</div>
        <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-slate-500">Laptop</dt>
            <dd className="font-medium">
              {info?.os} / {info?.arch}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">App version</dt>
            <dd className="font-medium">{info?.version}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Toolchain</dt>
            <dd className="font-medium">
              {verified}/{enabled} components verified
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">Attendance</dt>
            <dd>
              {checkedIn ? <Badge tone="green">Checked in</Badge> : <Badge>Not checked in</Badge>}
            </dd>
          </div>
        </dl>
        <div className="mt-5 space-y-2">
          {setup?.components
            .filter((c) => c.enabled)
            .map((c) => (
              <div key={c.id} className="flex items-center justify-between text-sm">
                <span>{c.name}</span>
                <span className="text-slate-500">
                  {c.status === 'verified'
                    ? `✓ ${c.version ?? ''}`
                    : c.status === 'failed'
                      ? 'needs repair'
                      : c.status}
                </span>
              </div>
            ))}
        </div>
      </Card>

      <Card className="flex flex-col items-center text-center">
        <div className="text-sm font-semibold">Attendance QR</div>
        {checkedIn && (
          <div className="mt-3 w-full">
            <Banner tone="success" title="You are checked in">
              Welcome! Keep this app running.
            </Banner>
          </div>
        )}
        {qr?.visible ? (
          <>
            <img
              src={qr.dataUrl}
              alt="Attendance QR code"
              className="mt-4 h-64 w-64 rounded-lg bg-white p-2"
              draggable={false}
            />
            <Countdown ms={qr.expiresInMs} />
            <p className="mt-3 text-xs text-slate-500">
              Show this at the entrance. The code changes every minute, so screenshots stop working.
            </p>
          </>
        ) : (
          <div className="mt-4 grid w-full place-items-center rounded-xl border-2 border-dashed border-slate-300 p-8 text-sm text-slate-500 dark:border-slate-700">
            <div className="mb-3 text-3xl">🔒</div>
            {qr ? qr.reason : 'Loading…'}
            {!setup?.complete && (
              <Button variant="primary" className="mt-4" onClick={onGoSetup}>
                {setup?.components.some((c) => c.status === 'failed')
                  ? 'Repair setup'
                  : 'Go to setup'}
              </Button>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
