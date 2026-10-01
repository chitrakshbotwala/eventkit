import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AdminStreamEvent, OverviewCounters } from '@eventkit/shared';
import { Badge, Banner, Card, Empty, Loading, PageHeader, Stat } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { fmtTime } from '../lib/format';
import { useStream } from '../lib/sse';

interface Activity {
  key: string;
  at: string;
  text: string;
  tone: 'green' | 'blue' | 'amber' | 'red' | 'gray';
  label: string;
}

function describe(e: AdminStreamEvent): Activity | null {
  const now = new Date().toISOString();
  switch (e.type) {
    case 'checkin':
      return {
        key: `c-${e.data.attendeeId}-${e.data.at}`,
        at: e.data.at,
        text: `${e.data.name} checked in (${e.data.method})`,
        tone: 'green',
        label: 'Check-in',
      };
    case 'readiness':
      return {
        key: `r-${e.data.attendeeId}-${now}`,
        at: now,
        text: `Readiness ${e.data.accepted ? 'accepted' : 'rejected'} for attendee ${e.data.attendeeId.slice(-6)}`,
        tone: e.data.accepted ? 'blue' : 'amber',
        label: 'Readiness',
      };
    case 'connectivity':
      if (!['online', 'limited', 'app_stop', 'clock_anomaly'].includes(e.data.eventType))
        return null;
      return {
        key: `n-${e.data.deviceId}-${e.data.at}-${e.data.eventType}`,
        at: e.data.at,
        text: `${e.data.name}: ${e.data.eventType.replace('_', ' ')}${e.data.source === 'uploaded_log' ? ' (from uploaded log)' : ''}`,
        tone: e.data.eventType === 'online' ? 'red' : 'amber',
        label: 'Phase 2',
      };
    case 'schedule':
      return {
        key: `s-${e.data.version}`,
        at: now,
        text: `Phase 2 schedule updated (v${e.data.version})`,
        tone: 'gray',
        label: 'Schedule',
      };
    default:
      return null;
  }
}

export function OverviewPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 30_000 });
  const [activity, setActivity] = useState<Activity[]>([]);

  useStream((e) => {
    if (e.type === 'counters') {
      qc.setQueryData(
        ['overview'],
        (old: { counters: OverviewCounters; serverTime: number } | undefined) => ({
          counters: e.data,
          serverTime: old?.serverTime ?? Date.now(),
        }),
      );
      return;
    }
    const a = describe(e);
    if (a)
      setActivity((prev) => (prev.some((p) => p.key === a.key) ? prev : [a, ...prev].slice(0, 60)));
  });

  if (q.isLoading) return <Loading />;
  if (q.error) return <Banner tone="error">{errorMessage(q.error)}</Banner>;
  const c = q.data!.counters;
  const pct = (n: number) => (c.rsvp ? Math.round((n / c.rsvp) * 100) : 0);

  return (
    <>
      <PageHeader title="Overview" subtitle="Live status of the event. Updates in real time." />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="RSVP'd" value={c.rsvp} />
        <Stat
          label="Logged in"
          value={c.loggedIn}
          tone="blue"
          hint={`${pct(c.loggedIn)}% of RSVPs`}
        />
        <Stat
          label="Installing"
          value={c.installing}
          tone="amber"
          hint="setup running or needs repair"
        />
        <Stat label="Ready" value={c.ready} tone="green" hint={`${pct(c.ready)}% of RSVPs`} />
        <Stat
          label="Checked in"
          value={c.checkedIn}
          tone="green"
          hint={`${pct(c.checkedIn)}% of RSVPs`}
        />
        <Stat
          label="Phase-2 compliant"
          value={c.compliant}
          tone="green"
          hint="verified log, never online"
        />
        <Stat
          label="Violations"
          value={c.violations}
          tone="red"
          hint="online during the window or tampered"
        />
        <Stat
          label="Warnings / unverified"
          value={`${c.warnings} / ${c.unverified}`}
          tone="amber"
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card title="Funnel">
          <div className="space-y-4">
            {[
              { label: 'Logged in', n: c.loggedIn, color: 'bg-brand-500' },
              { label: 'Ready (toolchain verified)', n: c.ready, color: 'bg-emerald-500' },
              { label: 'Checked in', n: c.checkedIn, color: 'bg-emerald-600' },
            ].map((row) => (
              <div key={row.label}>
                <div className="mb-1 flex justify-between text-sm">
                  <span>{row.label}</span>
                  <span className="tabular-nums text-slate-500">
                    {row.n} / {c.rsvp} ({pct(row.n)}%)
                  </span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className={`h-full rounded-full ${row.color} transition-[width] duration-500`}
                    style={{ width: `${pct(row.n)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Live activity">
          {activity.length === 0 ? (
            <Empty title="Waiting for activity">
              Check-ins, readiness and phase-2 alerts appear here.
            </Empty>
          ) : (
            <ul className="-my-2 max-h-96 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
              {activity.map((a) => (
                <li key={a.key} className="flex items-start gap-2 py-2 text-sm">
                  <Badge tone={a.tone}>{a.label}</Badge>
                  <span className="min-w-0 flex-1">{a.text}</span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-400">
                    {fmtTime(a.at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
