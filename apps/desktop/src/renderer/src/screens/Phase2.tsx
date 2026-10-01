import { useState } from 'react';
import { Badge, Banner, Button, Card } from '../components/ui';
import { ek, formatDuration, useAction, usePhase2 } from '../lib/hooks';

const NET_LABEL = {
  online: { text: 'Internet reachable', tone: 'red' as const },
  limited: { text: 'Network connected, no internet', tone: 'amber' as const },
  offline: { text: 'Offline', tone: 'green' as const },
};

export function Phase2() {
  const p = usePhase2();
  const doctor = useAction(ek.tools.runDoctor);
  const [doctorOut, setDoctorOut] = useState<string | null>(null);
  const openCode = useAction(ek.tools.openVsCode);
  const openFolder = useAction(ek.tools.openProjectFolder);
  if (!p) return null;

  const active = p.state === 'active';
  const net = NET_LABEL[p.net];
  const inGrace = active && p.msToStart !== null && -p.msToStart < p.graceSeconds * 1000;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      {active && p.net === 'online' && (
        <div className="rounded-2xl bg-red-600 px-6 py-5 text-white shadow-lg" role="alert">
          <div className="text-2xl font-bold">Disconnect now</div>
          <div className="mt-1 text-sm">
            The offline phase has started. Turn off Wi-Fi and unplug Ethernet.
            {inGrace
              ? ' You are still within the grace period.'
              : ' This time online is being recorded.'}
          </div>
        </div>
      )}
      {p.state === 'presync' && (
        <Banner
          tone={p.safeToDisconnect ? 'success' : 'info'}
          title={p.safeToDisconnect ? 'Safe to disconnect now' : 'Final sync in progress…'}
        >
          {p.safeToDisconnect
            ? 'Everything is synced. You can switch off Wi-Fi before the offline phase starts.'
            : 'Stay online for a moment while we sync the schedule and logs.'}
        </Banner>
      )}

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Offline phase</h1>
            <p className="mt-1 text-sm text-slate-500">
              {p.state === 'none' && 'No offline phase has been scheduled yet.'}
              {p.state === 'scheduled' &&
                p.startAt &&
                `Starts ${new Date(p.startAt).toLocaleString()}`}
              {p.state === 'presync' &&
                p.startAt &&
                `Starts ${new Date(p.startAt).toLocaleTimeString()}`}
              {active && p.endAt && `Ends ${new Date(p.endAt).toLocaleTimeString()}`}
              {p.state === 'ended' &&
                (p.pendingUpload > 0
                  ? 'The offline phase has ended. Reconnect so your log can be uploaded.'
                  : 'The offline phase has ended and your log has been uploaded.')}
            </p>
          </div>
          <div className="text-right">
            {(p.state === 'scheduled' || p.state === 'presync') && p.msToStart !== null && (
              <>
                <div className="text-xs uppercase tracking-wide text-slate-500">Starts in</div>
                <div className="text-4xl font-semibold tabular-nums">
                  {formatDuration(p.msToStart)}
                </div>
              </>
            )}
            {active && p.msToEnd !== null && (
              <>
                <div className="text-xs uppercase tracking-wide text-slate-500">Time left</div>
                <div className="text-4xl font-semibold tabular-nums">
                  {formatDuration(p.msToEnd)}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/60">
            <div className="text-xs text-slate-500">Connectivity</div>
            <div className="mt-1 flex items-center gap-2">
              <span
                className={`h-3 w-3 rounded-full ${p.net === 'online' ? 'bg-red-500' : p.net === 'limited' ? 'bg-amber-500' : 'bg-emerald-500'}`}
              />
              <span className="font-medium">{net.text}</span>
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {p.interfaces.length ? p.interfaces.join(', ') : 'no active network interfaces'}
            </div>
          </div>
          <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/60">
            <div className="text-xs text-slate-500">Compliance</div>
            <div className="mt-1">
              {p.compliance === 'compliant' && <Badge tone="green">Compliant so far</Badge>}
              {p.compliance === 'violation' && <Badge tone="red">Violation recorded</Badge>}
              {p.compliance === 'warning' && <Badge tone="amber">Warning</Badge>}
              {p.compliance === 'pending' && <Badge>Not started</Badge>}
            </div>
            {p.violationCount > 0 && (
              <div className="mt-1 text-xs text-slate-500">
                {p.violationCount} time(s) online, {Math.round(p.onlineSeconds)}s total
              </div>
            )}
          </div>
          <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-800/60">
            <div className="text-xs text-slate-500">Log</div>
            <div className="mt-1 font-medium">
              {p.pendingUpload > 0 ? `${p.pendingUpload} events to upload` : 'Up to date'}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {p.lastSyncAt
                ? `Last sync ${new Date(p.lastSyncAt).toLocaleTimeString()}`
                : 'Not synced yet'}
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <div className="text-sm font-semibold">Offline rules</div>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>
            During the offline phase your laptop must not connect to the internet (Wi-Fi, Ethernet,
            phone hotspot).
          </li>
          <li>
            Keep EventKit running. It lives in the system tray; quitting it is recorded as a
            monitoring gap.
          </li>
          <li>
            Everything you need (Flutter, packages for the starter project, VS Code extensions) is
            already installed.
          </li>
          <li>When the phase ends, reconnect so your log can be uploaded.</li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void openCode.run()} disabled={openCode.busy}>
            Open VS Code
          </Button>
          <Button onClick={() => void openFolder.run()} disabled={openFolder.busy || !p.projectDir}>
            Open project folder
          </Button>
          <Button
            onClick={() => void doctor.run().then((o) => o !== undefined && setDoctorOut(o))}
            disabled={doctor.busy}
          >
            {doctor.busy ? 'Running flutter doctor…' : 'Run flutter doctor'}
          </Button>
          <Button variant="ghost" onClick={() => void ek.phase2.sync()}>
            Sync now
          </Button>
        </div>
        {(openCode.error || openFolder.error || doctor.error) && (
          <div className="mt-3">
            <Banner tone="error">{openCode.error ?? openFolder.error ?? doctor.error}</Banner>
          </div>
        )}
      </Card>

      {doctorOut && (
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold">flutter doctor -v</span>
            <Button variant="ghost" onClick={() => setDoctorOut(null)}>
              Close
            </Button>
          </div>
          <pre className="selectable max-h-96 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] text-slate-200">
            {doctorOut}
          </pre>
        </Card>
      )}
    </div>
  );
}
