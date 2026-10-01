import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ImportResult } from '@eventkit/shared';
import { AttendeeStatusBadge, ComplianceBadge, ComponentStatusBadge } from '../components/status';
import {
  Badge,
  Banner,
  Button,
  Card,
  Drawer,
  Empty,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '../components/ui';
import { api, errorMessage, type AttendeeDetail } from '../lib/api';
import { fmtDateTime, fmtRelative, fmtSeconds } from '../lib/format';
import { useStream } from '../lib/sse';

const STATUS_FILTERS = [
  { value: 'all', label: 'All statuses' },
  { value: 'invited', label: 'Invited (not logged in)' },
  { value: 'logged_in', label: 'Logged in' },
  { value: 'installing', label: 'Installing' },
  { value: 'ready', label: 'Ready' },
  { value: 'not_ready', label: 'Needs repair' },
  { value: 'checked_in', label: 'Checked in' },
];

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function AttendeesPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const q = useDebounced(search.trim(), 250);
  const pageSize = 50;

  useEffect(() => setPage(1), [q, status]);

  const list = useQuery({
    queryKey: ['attendees', q, status, page],
    queryFn: () => api.attendees({ q: q || undefined, status, page, pageSize }),
    placeholderData: keepPreviousData,
  });

  useStream((e) => {
    if (e.type === 'progress' || e.type === 'readiness' || e.type === 'checkin') {
      void qc.invalidateQueries({ queryKey: ['attendees'] });
      if ('attendeeId' in e.data && e.data.attendeeId === selected)
        void qc.invalidateQueries({ queryKey: ['attendee', selected] });
    }
  });

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <PageHeader
        title="Attendees"
        subtitle={`${total} attendee${total === 1 ? '' : 's'}${status !== 'all' || q ? ' match' : ' on the RSVP list'}`}
        actions={
          <>
            <Button onClick={() => setAddOpen(true)}>Add attendee</Button>
            <Button variant="primary" onClick={() => setImportOpen(true)}>
              Import RSVP CSV
            </Button>
          </>
        }
      />
      <Card>
        <div className="-mt-1 mb-4 flex flex-wrap gap-3">
          <div className="min-w-60 flex-1">
            <Input
              type="search"
              placeholder="Search name or email…"
              aria-label="Search attendees"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="w-56"
          >
            {STATUS_FILTERS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </Select>
        </div>
        {list.isLoading ? (
          <Loading />
        ) : list.error ? (
          <Banner tone="error">{errorMessage(list.error)}</Banner>
        ) : list.data!.items.length === 0 ? (
          <Empty title="No attendees found">
            {q || status !== 'all'
              ? 'Try another search or filter.'
              : 'Import your RSVP list to get started.'}
          </Empty>
        ) : (
          <div className="mt-5">
            <Table>
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <Th>Name</Th>
                  <Th>Status</Th>
                  <Th>Setup</Th>
                  <Th>Checked in</Th>
                  <Th>Phase 2</Th>
                  <Th>Last seen</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {list.data!.items.map((a) => (
                  <tr
                    key={a.id}
                    className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                    onClick={() => setSelected(a.id)}
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && setSelected(a.id)}
                  >
                    <Td>
                      <div className="font-medium">{a.name}</div>
                      <div className="text-xs text-slate-500">{a.email}</div>
                    </Td>
                    <Td>
                      <AttendeeStatusBadge status={a.status} />
                    </Td>
                    <Td>
                      {a.overallPercent === null ? (
                        <span className="text-xs text-slate-400">—</span>
                      ) : (
                        <div className="flex w-32 items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                            <div
                              className={`h-full ${a.overallPercent >= 100 ? 'bg-emerald-500' : 'bg-brand-500'}`}
                              style={{ width: `${a.overallPercent}%` }}
                            />
                          </div>
                          <span className="w-9 text-right text-xs tabular-nums text-slate-500">
                            {Math.round(a.overallPercent)}%
                          </span>
                        </div>
                      )}
                    </Td>
                    <Td className="whitespace-nowrap text-xs tabular-nums">
                      {a.checkedInAt ? (
                        fmtDateTime(a.checkedInAt)
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </Td>
                    <Td>
                      <ComplianceBadge status={a.compliance} />
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-slate-500">
                      {fmtRelative(a.lastSeenAt)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        {pages > 1 && (
          <div className="mt-8 flex items-center justify-between text-sm">
            <span className="text-slate-500 tabular-nums">
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
      <AddDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <AttendeeDrawer id={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const m = useMutation({
    mutationFn: async (f: File) => api.importCsv(await f.text()),
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['attendees'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  const close = () => {
    setFile(null);
    setResult(null);
    m.reset();
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title="Import RSVP list"
      footer={
        result ? (
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!file || m.isPending}
              onClick={() => file && m.mutate(file)}
            >
              {m.isPending && <Spinner />} Import
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-3 text-center">
            {[
              ['Created', result.created, 'text-emerald-600'],
              ['Updated', result.updated, 'text-brand-600'],
              ['Unchanged / skipped', result.skipped, 'text-slate-600'],
              ['Duplicates in file', result.duplicates, 'text-amber-600'],
            ].map(([l, n, c]) => (
              <div key={l as string} className="rounded-lg bg-slate-50 p-3 dark:bg-slate-800">
                <div className={`text-2xl font-semibold tabular-nums ${c as string}`}>{n}</div>
                <div className="text-xs text-slate-500">{l}</div>
              </div>
            ))}
          </div>
          {result.errors.length > 0 && (
            <div>
              <div className="mb-1 text-sm font-medium">
                Rows with problems ({result.errors.length})
              </div>
              <ul className="max-h-48 overflow-y-auto rounded-lg bg-slate-50 p-3 font-mono text-xs dark:bg-slate-800">
                {result.errors.slice(0, 200).map((e) => (
                  <li key={`${e.line}-${e.message}`}>
                    line {e.line}: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <p className="text-slate-600 dark:text-slate-300">
            Upload a CSV export (Meetup, Luma, Google Forms, …). Recognised columns:{' '}
            <code>email</code> and <code>name</code> (or first/last name). Existing attendees are
            matched case-insensitively by email and updated; duplicates in the file are merged.
          </p>
          <Field label="CSV file">
            {(id) => (
              <input
                id={id}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:font-medium file:text-brand-700 hover:file:bg-brand-100"
              />
            )}
          </Field>
          {m.error && <Banner tone="error">{errorMessage(m.error)}</Banner>}
        </div>
      )}
    </Modal>
  );
}

function AddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const m = useMutation({
    mutationFn: () => api.createAttendee(email.trim(), name.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['attendees'] });
      setEmail('');
      setName('');
      onClose();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Modal open={open} onClose={onClose} title="Add attendee">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          {(id) => (
            <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
        <Field label="Email">
          {(id) => (
            <Input
              id={id}
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        {m.error && <Banner tone="error">{errorMessage(m.error)}</Banner>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={m.isPending}>
            Add
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </section>
  );
}

function AttendeeDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const d = useQuery({
    queryKey: ['attendee', id],
    queryFn: () => api.attendee(id!),
    enabled: Boolean(id),
    refetchInterval: 15_000,
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['attendee', id] });
    void qc.invalidateQueries({ queryKey: ['attendees'] });
  };
  const revoke = useMutation({ mutationFn: () => api.revokeQr(id!), onSuccess: invalidate });
  const del = useMutation({
    mutationFn: () => api.deleteAttendee(id!),
    onSuccess: () => {
      invalidate();
      setConfirmDelete(false);
      onClose();
    },
  });
  const rename = useMutation({
    mutationFn: () => {
      const patch: { name?: string; email?: string } = { name: name.trim() };
      // Changing the email to the attendee's Google address fixes "not on the RSVP list".
      if (email.trim().toLowerCase() !== d.data?.attendee.email) patch.email = email.trim();
      return api.updateAttendee(id!, patch);
    },
    onSuccess: () => {
      setEditing(false);
      invalidate();
    },
  });

  const data = d.data;
  return (
    <Drawer
      open={Boolean(id)}
      onClose={() => {
        setEditing(false);
        setConfirmDelete(false);
        onClose();
      }}
      title={
        data ? (
          <div>
            <div className="flex items-center gap-2">
              <span className="truncate text-lg font-semibold">{data.attendee.name}</span>
              <AttendeeStatusBadge status={data.attendee.status} />
            </div>
            <div className="text-sm text-slate-500">{data.attendee.email}</div>
          </div>
        ) : (
          <span className="text-lg font-semibold">Attendee</span>
        )
      }
    >
      {d.isLoading || !data ? (
        d.error ? (
          <Banner tone="error">{errorMessage(d.error)}</Banner>
        ) : (
          <Loading />
        )
      ) : (
        <DrawerBody
          data={data}
          actions={
            <div className="flex flex-wrap gap-2">
              {editing ? (
                <>
                  <Input
                    aria-label="Name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-48"
                  />
                  <Input
                    aria-label="Email (must match their Google account)"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-64"
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={!name.trim() || !email.trim() || rename.isPending}
                    onClick={() => rename.mutate()}
                  >
                    Save
                  </Button>
                  <Button size="sm" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  onClick={() => {
                    setName(data.attendee.name);
                    setEmail(data.attendee.email);
                    setEditing(true);
                  }}
                >
                  Edit name / email
                </Button>
              )}
              <Button
                size="sm"
                disabled={!data.attendee.hasQrSecret || revoke.isPending}
                onClick={() => revoke.mutate()}
                title="Force the attendee to pass readiness again"
              >
                Revoke QR
              </Button>
              {confirmDelete ? (
                <>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={del.isPending}
                    onClick={() => del.mutate()}
                  >
                    Confirm delete
                  </Button>
                  <Button size="sm" onClick={() => setConfirmDelete(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-600"
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </Button>
              )}
              {(revoke.error || del.error || rename.error) && (
                <Banner tone="error">
                  {errorMessage(revoke.error ?? del.error ?? rename.error)}
                </Banner>
              )}
            </div>
          }
        />
      )}
    </Drawer>
  );
}

function DrawerBody({ data, actions }: { data: AttendeeDetail; actions: ReactNode }) {
  const byDevice = new Map<string, AttendeeDetail['progress']>();
  for (const p of data.progress) byDevice.set(p.deviceId, [...(byDevice.get(p.deviceId) ?? []), p]);
  const c = data.compliance;

  return (
    <div className="text-sm">
      <div className="mb-6">{actions}</div>

      <Section title="Summary">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
          <dt className="text-slate-500">Ready since</dt>
          <dd>{fmtDateTime(data.attendee.readyAt)}</dd>
          <dt className="text-slate-500">QR secret issued</dt>
          <dd>{data.attendee.hasQrSecret ? 'Yes' : 'No'}</dd>
          <dt className="text-slate-500">Last seen</dt>
          <dd>{fmtRelative(data.attendee.lastSeenAt)}</dd>
          <dt className="text-slate-500">Checked in</dt>
          <dd>
            {data.attendance ? (
              <>
                {fmtDateTime(data.attendance.checkedInAt)} · {data.attendance.method}
                {data.attendance.scanner && ` by ${data.attendance.scanner.name}`}
                {data.attendance.reason && (
                  <div className="text-xs text-slate-500">Reason: {data.attendance.reason}</div>
                )}
              </>
            ) : (
              'Not yet'
            )}
          </dd>
        </dl>
      </Section>

      <Section title={`Devices (${data.devices.length})`}>
        {data.devices.length === 0 ? (
          <p className="text-slate-500">Never signed in on a laptop.</p>
        ) : (
          <div className="space-y-3">
            {data.devices.map((dev) => (
              <div key={dev.id} className="rounded-lg ring-1 ring-slate-200 dark:ring-slate-800">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
                  <div>
                    <span className="font-medium">{dev.hostname ?? dev.id.slice(-8)}</span>{' '}
                    <span className="text-xs text-slate-500">
                      {dev.os}/{dev.arch} · app {dev.appVersion}
                    </span>
                  </div>
                  <span className="text-xs text-slate-500">
                    {dev.overallPercent !== null && `${Math.round(dev.overallPercent)}% · `}seen{' '}
                    {fmtRelative(dev.lastSeenAt)}
                  </span>
                </div>
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {(byDevice.get(dev.id) ?? []).map((p) => (
                    <li
                      key={p.componentId}
                      className="flex items-start justify-between gap-3 px-3 py-1.5"
                    >
                      <span className="w-28 shrink-0 font-mono text-xs">{p.componentId}</span>
                      <span
                        className="min-w-0 flex-1 truncate text-xs text-slate-500"
                        title={p.message ?? ''}
                      >
                        {p.version && (
                          <span className="mr-2 text-slate-700 dark:text-slate-300">
                            {p.version}
                          </span>
                        )}
                        {p.message}
                      </span>
                      <ComponentStatusBadge status={p.status} />
                    </li>
                  ))}
                  {!byDevice.get(dev.id)?.length && (
                    <li className="px-3 py-2 text-xs text-slate-500">
                      No setup progress reported yet.
                    </li>
                  )}
                </ul>
                <div className="px-3 py-1.5 text-xs text-slate-400">{dev.osVersion}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Readiness reports">
        {data.readiness.length === 0 ? (
          <p className="text-slate-500">No readiness report submitted.</p>
        ) : (
          <ul className="space-y-2">
            {data.readiness.map((r) => (
              <li key={r.id} className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/50">
                <div className="flex items-center justify-between">
                  <Badge tone={r.accepted ? 'green' : 'red'}>
                    {r.accepted ? 'Accepted' : 'Rejected'}
                  </Badge>
                  <span className="text-xs text-slate-500">{fmtDateTime(r.createdAt)}</span>
                </div>
                {r.reasons.length > 0 && (
                  <ul className="mt-1 list-disc pl-5 text-xs text-slate-600 dark:text-slate-300">
                    {r.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Phase 2 compliance">
        {!c ? (
          <p className="text-slate-500">No data.</p>
        ) : (
          <div className="rounded-lg ring-1 ring-slate-200 p-3 dark:ring-slate-800">
            <div className="flex flex-wrap items-center gap-2">
              <ComplianceBadge status={c.status} />
              {c.flags
                .filter((f) => f !== c.status)
                .map((f) => (
                  <ComplianceBadge key={f} status={f} />
                ))}
              {c.logVerified && <Badge tone="blue">log verified</Badge>}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
              <dt className="text-slate-500">First seen online</dt>
              <dd>{fmtDateTime(c.firstSeenOnline)}</dd>
              <dt className="text-slate-500">Time online</dt>
              <dd className="tabular-nums">
                {fmtSeconds(c.totalOnlineSeconds)} ({c.onlineCount}×)
              </dd>
              <dt className="text-slate-500">Interface up, no internet</dt>
              <dd className="tabular-nums">{fmtSeconds(c.limitedSeconds)}</dd>
              <dt className="text-slate-500">Monitoring gaps</dt>
              <dd className="tabular-nums">{fmtSeconds(c.gapSeconds)}</dd>
            </dl>
            {c.notes.length > 0 && (
              <div className="mt-2 text-xs text-slate-500">{c.notes.join(' · ')}</div>
            )}
          </div>
        )}
        {data.logs.length > 0 && (
          <ul className="mt-3 space-y-1 text-xs">
            {data.logs.map((l) => (
              <li key={l.logId} className="flex items-center gap-2">
                <Badge tone={l.chainValid ? 'green' : 'red'}>
                  {l.chainValid ? 'chain ok' : 'chain broken'}
                </Badge>
                <span className="text-slate-500">
                  {l.entryCount} entries, uploaded {fmtRelative(l.uploadedAt)}
                </span>
                {l.errors.length > 0 && <span className="text-red-600">{l.errors[0]}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Connectivity timeline">
        {data.connectivity.length === 0 ? (
          <p className="text-slate-500">No connectivity events.</p>
        ) : (
          <ol className="relative ml-2 border-l border-slate-200 dark:border-slate-700">
            {data.connectivity.slice(0, 150).map((e) => {
              const bad =
                e.type === 'online' || (e.type === 'heartbeat' && e.data?.state === 'online');
              const warn =
                e.type === 'limited' || e.type === 'clock_anomaly' || e.type === 'app_stop';
              return (
                <li key={e.id} className="mb-2 ml-4">
                  <span
                    className={`absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full ring-2 ring-white dark:ring-slate-900 ${bad ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-600'}`}
                  />
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="tabular-nums text-slate-500">{fmtDateTime(e.at)}</span>
                    <span className={`font-medium ${bad ? 'text-red-600' : ''}`}>
                      {e.type.replace('_', ' ')}
                    </span>
                    {e.data?.state && <span className="text-slate-500">state: {e.data.state}</span>}
                    {e.source === 'uploaded_log' && <Badge>log</Badge>}
                    {!e.valid && <Badge tone="red">invalid HMAC</Badge>}
                  </div>
                  {e.data?.interfaces && e.data.interfaces.length > 0 && (
                    <div className="text-xs text-slate-400">{e.data.interfaces.join(', ')}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </Section>
    </div>
  );
}
