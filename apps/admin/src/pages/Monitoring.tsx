import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ComplianceStatus } from '@eventkit/shared';
import { COMPLIANCE, ComplianceBadge } from '../components/status';
import { Badge, Banner, Card, Empty, Input, LinkButton, Loading, PageHeader, Table, Td, Th } from '../components/ui';
import { api, errorMessage, exportUrl, type FeedItem } from '../lib/api';
import { fmtDateTime, fmtRelative, fmtSeconds, fmtTime } from '../lib/format';
import { useStream } from '../lib/sse';

const ORDER: ComplianceStatus[] = ['violation', 'tampered', 'monitoring_gap', 'warning', 'unverified', 'compliant'];

export function MonitoringPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['monitoring'], queryFn: api.monitoring, refetchInterval: 15_000 });
  const feed = useQuery({ queryKey: ['monitoring-feed'], queryFn: () => api.feed(200), refetchInterval: 60_000 });
  const [live, setLive] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<ComplianceStatus | 'all'>('all');
  const [filter, setFilter] = useState('');

  useStream((e) => {
    if (e.type === 'connectivity') {
      const item: FeedItem = {
        id: `live-${e.data.deviceId}-${e.data.at}-${e.data.eventType}`,
        attendeeId: e.data.attendeeId,
        name: e.data.name,
        deviceId: e.data.deviceId,
        type: e.data.eventType,
        state: e.data.state,
        at: e.data.at,
        source: e.data.source,
        valid: true,
      };
      setLive((prev) => [item, ...prev].slice(0, 200));
      if (['online', 'limited', 'app_stop', 'clock_anomaly'].includes(item.type) || item.source === 'uploaded_log') {
        void qc.invalidateQueries({ queryKey: ['monitoring'] });
      }
    } else if (e.type === 'schedule') {
      void qc.invalidateQueries({ queryKey: ['monitoring'] });
    }
  });

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return (q.data?.rows ?? [])
      .filter((r) => status === 'all' || r.status === status)
      .filter((r) => !f || r.name.toLowerCase().includes(f) || r.email.includes(f))
      .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.totalOnlineSeconds - a.totalOnlineSeconds || a.name.localeCompare(b.name));
  }, [q.data, status, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of q.data?.rows ?? []) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [q.data]);

  const feedItems = useMemo(() => {
    const seen = new Set<string>();
    const merged = [...live, ...(feed.data?.items ?? [])].filter((i) => {
      const k = `${i.deviceId}|${i.at}|${i.type}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return merged.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
  }, [live, feed.data]);

  if (q.isLoading) return <Loading />;
  if (q.error) return <Banner tone="error">{errorMessage(q.error)}</Banner>;
  const s = q.data!.schedule;
  const started = s.startAt && Date.parse(s.startAt) <= q.data!.serverTime;

  return (
    <>
      <PageHeader
        title="Connectivity monitoring"
        subtitle={
          s.startAt && s.endAt
            ? `Window ${fmtDateTime(s.startAt, s.timezone)} to ${fmtDateTime(s.endAt, s.timezone)} (${s.timezone}), ${s.mode} mode, ${s.graceSeconds}s grace`
            : 'No offline phase scheduled yet.'
        }
        actions={
          <>
            <LinkButton href={exportUrl.monitoring('csv')} download>
              Export CSV
            </LinkButton>
            <LinkButton href={exportUrl.monitoring('xlsx')} variant="primary" download>
              Export XLSX
            </LinkButton>
          </>
        }
      />

      {!started && (
        <div className="mb-6">
          <Banner tone="info">Phase 2 has not started. Everyone shows as Unverified until the window starts and logs are uploaded.</Banner>
        </div>
      )}

      <div className="mb-6 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        <button
          type="button"
          onClick={() => setStatus('all')}
          className={`rounded-full px-3 py-1 text-sm ring-1 ring-inset ${status === 'all' ? 'bg-slate-900 text-white ring-slate-900 dark:bg-white dark:text-slate-900' : 'ring-slate-300 hover:bg-slate-50 dark:ring-slate-700 dark:hover:bg-slate-800'}`}
        >
          All <span className="tabular-nums opacity-70">{q.data!.rows.length}</span>
        </button>
        {ORDER.map((st) => (
          <button
            key={st}
            type="button"
            title={COMPLIANCE[st].help}
            onClick={() => setStatus(st)}
            className={`rounded-full ring-inset transition ${status === st ? 'ring-2 ring-brand-500' : ''}`}
          >
            <Badge tone={COMPLIANCE[st].tone}>
              {COMPLIANCE[st].label} <span className="tabular-nums">{counts[st] ?? 0}</span>
            </Badge>
          </button>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[3fr_1fr]">
        <Card
          title="Attendees"
          actions={<Input type="search" aria-label="Filter" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48" />}
        >
          {rows.length === 0 ? (
            <Empty title="No attendees in this view" />
          ) : (
            <Table>
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <Th>Attendee</Th>
                  <Th>Status</Th>
                  <Th>First online</Th>
                  <Th className="text-right">Online</Th>
                  <Th className="text-right">Count</Th>
                  <Th className="text-right">Gaps</Th>
                  <Th>Last event</Th>
                  <Th>Log</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r) => (
                  <tr key={r.attendeeId} className={r.status === 'violation' || r.status === 'tampered' ? 'bg-red-50/60 dark:bg-red-950/20' : ''}>
                    <Td>
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-slate-500">{r.email}</div>
                      {r.notes.length > 0 && <div className="mt-0.5 max-w-xs text-xs text-slate-400">{r.notes.join(' · ')}</div>}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        <ComplianceBadge status={r.status} />
                        {r.flags
                          .filter((f) => f !== r.status && f !== 'compliant')
                          .map((f) => (
                            <ComplianceBadge key={f} status={f} />
                          ))}
                      </div>
                    </Td>
                    <Td className="whitespace-nowrap text-xs tabular-nums">{r.firstSeenOnline ? fmtTime(r.firstSeenOnline) : '—'}</Td>
                    <Td className="text-right tabular-nums">{r.totalOnlineSeconds ? fmtSeconds(r.totalOnlineSeconds) : '—'}</Td>
                    <Td className="text-right tabular-nums">{r.onlineCount || '—'}</Td>
                    <Td className="text-right tabular-nums">{r.gapSeconds ? fmtSeconds(r.gapSeconds) : '—'}</Td>
                    <Td className="whitespace-nowrap text-xs text-slate-500">{fmtRelative(r.lastEventAt)}</Td>
                    <Td>{r.logVerified ? <Badge tone="green">verified</Badge> : <Badge>not yet</Badge>}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title="Live feed">
          {feedItems.length === 0 ? (
            <Empty title="No connectivity events yet" />
          ) : (
            <ul className="-my-2 max-h-[40rem] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
              {feedItems.map((i) => {
                const bad = i.type === 'online' || i.state === 'online';
                const warn = i.type === 'limited' || i.type === 'clock_anomaly' || i.type === 'app_stop';
                return (
                  <li key={i.id} className="py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{i.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-400">{fmtTime(i.at)}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs">
                      <Badge tone={bad ? 'red' : warn ? 'amber' : 'gray'}>{i.type.replace('_', ' ')}</Badge>
                      {i.state && i.type === 'heartbeat' && <span className="text-slate-500">{i.state}</span>}
                      {i.source === 'uploaded_log' && <span className="text-slate-400">from log</span>}
                      {!i.valid && <Badge tone="red">invalid</Badge>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6 grid gap-3 text-xs text-slate-500 sm:grid-cols-2 lg:grid-cols-3">
        {ORDER.map((st) => (
          <div key={st} className="flex items-start gap-2">
            <ComplianceBadge status={st} />
            <span>{COMPLIANCE[st].help}</span>
          </div>
        ))}
      </div>
    </>
  );
}
