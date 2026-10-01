import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Badge, Banner, Card, Empty, Input, LinkButton, Loading, PageHeader, Table, Td, Th } from '../components/ui';
import { api, errorMessage, exportUrl } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useStream } from '../lib/sse';

export function AttendancePage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['attendance'], queryFn: api.attendance, refetchInterval: 60_000 });
  const [filter, setFilter] = useState('');
  const [method, setMethod] = useState<'all' | 'qr' | 'manual'>('all');

  useStream((e) => {
    if (e.type === 'checkin') void qc.invalidateQueries({ queryKey: ['attendance'] });
  });

  const rows = useMemo(() => {
    const items = [...(q.data?.items ?? [])].sort((a, b) => b.checkedInAt.localeCompare(a.checkedInAt));
    const f = filter.trim().toLowerCase();
    return items.filter(
      (r) => (method === 'all' || r.method === method) && (!f || r.name.toLowerCase().includes(f) || r.email.includes(f)),
    );
  }, [q.data, filter, method]);

  const total = q.data?.items.length ?? 0;
  const manual = q.data?.items.filter((r) => r.method === 'manual').length ?? 0;

  return (
    <>
      <PageHeader
        title="Attendance"
        subtitle={`${total} checked in${manual ? ` (${manual} manual)` : ''}. Updates live as people are scanned.`}
        actions={
          <>
            <LinkButton href={exportUrl.attendance('csv')} download>
              Download CSV
            </LinkButton>
            <LinkButton href={exportUrl.attendance('xlsx')} variant="primary" download>
              Download XLSX
            </LinkButton>
          </>
        }
      />
      <Card>
        <div className="-mt-1 mb-4 flex flex-wrap gap-3">
          <Input type="search" aria-label="Filter attendance" placeholder="Filter by name or email…" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-sm" />
          <div className="flex rounded-lg ring-1 ring-slate-300 dark:ring-slate-700" role="group" aria-label="Method">
            {(['all', 'qr', 'manual'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMethod(m)}
                className={`px-3 py-1.5 text-sm first:rounded-l-lg last:rounded-r-lg ${method === m ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'}`}
                aria-pressed={method === m}
              >
                {m === 'all' ? 'All' : m === 'qr' ? 'QR' : 'Manual'}
              </button>
            ))}
          </div>
        </div>
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <Banner tone="error">{errorMessage(q.error)}</Banner>
        ) : rows.length === 0 ? (
          <Empty title="No check-ins yet">{total ? 'Nothing matches the filter.' : 'Scanned attendees appear here.'}</Empty>
        ) : (
          <div className="mt-5">
            <Table>
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <Th>#</Th>
                  <Th>Name</Th>
                  <Th>Checked in</Th>
                  <Th>Method</Th>
                  <Th>Scanner</Th>
                  <Th>Reason</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((r, i) => (
                  <tr key={r.attendeeId}>
                    <Td className="tabular-nums text-slate-400">{rows.length - i}</Td>
                    <Td>
                      <div className="font-medium">{r.name}</div>
                      <div className="text-xs text-slate-500">{r.email}</div>
                    </Td>
                    <Td className="whitespace-nowrap tabular-nums">{fmtDateTime(r.checkedInAt)}</Td>
                    <Td>
                      <Badge tone={r.method === 'qr' ? 'green' : 'amber'}>{r.method === 'qr' ? 'QR' : 'Manual'}</Badge>
                    </Td>
                    <Td>
                      <div>{r.scannerName ?? '—'}</div>
                      {r.scannerEmail && <div className="text-xs text-slate-500">{r.scannerEmail}</div>}
                    </Td>
                    <Td className="text-xs text-slate-600 dark:text-slate-300">{r.reason ?? ''}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>
    </>
  );
}
