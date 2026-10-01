import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { PhaseMode, Schedule } from '@eventkit/shared';
import { Badge, Banner, Button, Card, Field, Input, Loading, Modal, PageHeader, Select, Spinner } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { allTimeZones, fmtCountdown, fmtDateTime, isoToLocalInput, localInputToIso, tzLabel } from '../lib/format';
import { useStream } from '../lib/sse';

type State = 'none' | 'scheduled' | 'presync' | 'active' | 'ended';

function phaseState(s: Schedule, now: number): State {
  if (!s.startAt || !s.endAt) return 'none';
  const start = Date.parse(s.startAt);
  const end = Date.parse(s.endAt);
  if (now >= end) return 'ended';
  if (now >= start) return 'active';
  if (now >= start - s.preSyncMinutes * 60_000) return 'presync';
  return 'scheduled';
}

const STATE_META: Record<State, { label: string; tone: 'gray' | 'blue' | 'amber' | 'red' | 'green' }> = {
  none: { label: 'Not scheduled', tone: 'gray' },
  scheduled: { label: 'Scheduled', tone: 'blue' },
  presync: { label: 'Final sync (attendees may disconnect)', tone: 'amber' },
  active: { label: 'OFFLINE PHASE ACTIVE', tone: 'red' },
  ended: { label: 'Ended', tone: 'green' },
};

/** Server-corrected clock ticking every second. */
function useServerNow(serverTime: number | undefined) {
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (serverTime) setOffset(serverTime - Date.now());
  }, [serverTime]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now + offset;
}

export function Phase2Page() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['schedule'], queryFn: api.schedule, refetchInterval: 30_000 });
  const now = useServerNow(q.data?.serverTime);
  const [confirm, setConfirm] = useState<'start' | 'end' | null>(null);

  useStream((e) => {
    if (e.type === 'schedule') void qc.invalidateQueries({ queryKey: ['schedule'] });
  });

  const setData = (d: { schedule: Schedule; serverTime: number }) => qc.setQueryData(['schedule'], d);
  const startNow = useMutation({ mutationFn: api.startNow, onSuccess: (d) => (setData(d), setConfirm(null)) });
  const endNow = useMutation({ mutationFn: api.endNow, onSuccess: (d) => (setData(d), setConfirm(null)) });

  if (q.isLoading) return <Loading />;
  if (q.error) return <Banner tone="error">{errorMessage(q.error)}</Banner>;
  const s = q.data!.schedule;
  const state = phaseState(s, now);
  const meta = STATE_META[state];
  const start = s.startAt ? Date.parse(s.startAt) : null;
  const end = s.endAt ? Date.parse(s.endAt) : null;

  return (
    <>
      <PageHeader title="Phase 2 control" subtitle="Schedule the offline phase. Attendee apps sync this every minute while online." />

      <div className={`mb-6 rounded-xl p-6 ring-1 ${state === 'active' ? 'bg-red-600 text-white ring-red-700' : 'bg-white ring-slate-200 dark:bg-slate-900 dark:ring-slate-800'}`}>
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div>
            <div className={`text-xs font-semibold uppercase tracking-wide ${state === 'active' ? 'text-red-100' : 'text-slate-500'}`}>Current state</div>
            <div className="mt-1 flex items-center gap-2 text-2xl font-semibold">
              {state === 'active' ? meta.label : <Badge tone={meta.tone}>{meta.label}</Badge>}
            </div>
            <div className={`mt-2 text-sm ${state === 'active' ? 'text-red-100' : 'text-slate-500'}`}>
              {start && `Start ${fmtDateTime(s.startAt, s.timezone)}`}
              {end && ` · End ${fmtDateTime(s.endAt, s.timezone)}`} {s.startAt && `(${s.timezone})`} · {s.mode} mode · grace {s.graceSeconds}s · v{s.version}
            </div>
          </div>
          <div className="text-right">
            {(state === 'scheduled' || state === 'presync') && start && (
              <>
                <div className="text-xs uppercase tracking-wide text-slate-500">Starts in</div>
                <div className="text-5xl font-semibold tabular-nums">{fmtCountdown(start - now)}</div>
              </>
            )}
            {state === 'active' && end && (
              <>
                <div className="text-xs uppercase tracking-wide text-red-100">Ends in</div>
                <div className="text-5xl font-semibold tabular-nums">{fmtCountdown(end - now)}</div>
              </>
            )}
          </div>
        </div>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button size="lg" variant={state === 'active' ? 'secondary' : 'danger'} disabled={state === 'active'} onClick={() => setConfirm('start')}>
            Start now
          </Button>
          <Button size="lg" variant={state === 'active' ? 'success' : 'secondary'} disabled={state !== 'active'} onClick={() => setConfirm('end')}>
            End now
          </Button>
        </div>
      </div>

      <ScheduleForm schedule={s} onSaved={setData} />

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'start' ? 'Start the offline phase now?' : 'End the offline phase now?'}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            {confirm === 'start' ? (
              <Button variant="danger" disabled={startNow.isPending} onClick={() => startNow.mutate()}>
                {startNow.isPending && <Spinner />} Start now
              </Button>
            ) : (
              <Button variant="success" disabled={endNow.isPending} onClick={() => endNow.mutate()}>
                {endNow.isPending && <Spinner />} End now
              </Button>
            )}
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          {confirm === 'start'
            ? `The phase starts immediately. Online attendees see "Disconnect now" and have ${s.graceSeconds}s of grace. Offline laptops pick this up only if they cached the schedule, so announce it in the room too.`
            : 'The phase ends immediately. Attendees can reconnect so their logs are uploaded and verified.'}
        </p>
        {(startNow.error || endNow.error) && (
          <div className="mt-3">
            <Banner tone="error">{errorMessage(startNow.error ?? endNow.error)}</Banner>
          </div>
        )}
      </Modal>
    </>
  );
}

function ScheduleForm({ schedule, onSaved }: { schedule: Schedule; onSaved: (d: { schedule: Schedule; serverTime: number }) => void }) {
  const zones = useMemo(allTimeZones, []);
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [tz, setTz] = useState(schedule.timezone || browserTz);
  const [startLocal, setStartLocal] = useState(isoToLocalInput(schedule.startAt, schedule.timezone || browserTz));
  const [endLocal, setEndLocal] = useState(isoToLocalInput(schedule.endAt, schedule.timezone || browserTz));
  const [mode, setMode] = useState<PhaseMode>(schedule.mode);
  const [grace, setGrace] = useState(String(schedule.graceSeconds));
  const [heartbeat, setHeartbeat] = useState(String(schedule.heartbeatSeconds));
  const [saved, setSaved] = useState(false);

  // Re-sync the form when the schedule changes elsewhere (start/end now, another admin).
  useEffect(() => {
    const zone = schedule.timezone || browserTz;
    setTz(zone);
    setStartLocal(isoToLocalInput(schedule.startAt, zone));
    setEndLocal(isoToLocalInput(schedule.endAt, zone));
    setMode(schedule.mode);
    setGrace(String(schedule.graceSeconds));
    setHeartbeat(String(schedule.heartbeatSeconds));
  }, [schedule.version, schedule.timezone, schedule.startAt, schedule.endAt, schedule.mode, schedule.graceSeconds, schedule.heartbeatSeconds, browserTz]);

  const save = useMutation({
    mutationFn: () =>
      api.saveSchedule({
        startAt: startLocal ? localInputToIso(startLocal, tz) : null,
        endAt: endLocal ? localInputToIso(endLocal, tz) : null,
        timezone: tz,
        mode,
        graceSeconds: Number(grace),
        heartbeatSeconds: Number(heartbeat),
      }),
    onSuccess: (d) => {
      onSaved(d);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const startIso = startLocal ? localInputToIso(startLocal, tz) : null;
  const endIso = endLocal ? localInputToIso(endLocal, tz) : null;
  const invalid = Boolean(startIso && endIso && Date.parse(endIso) <= Date.parse(startIso));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!invalid) save.mutate();
  };

  return (
    <Card title="Schedule">
      <form onSubmit={submit} className="grid gap-5 md:grid-cols-2">
        <Field label="Time zone" hint={`${tzLabel(tz)}. Times below are wall-clock times in this zone.`}>
          {(id) => (
            <Select id={id} value={tz} onChange={(e) => setTz(e.target.value)}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Mode" hint="Strict also warns when a network interface is up without internet.">
          {(id) => (
            <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as PhaseMode)}>
              <option value="strict">Strict</option>
              <option value="lenient">Lenient</option>
            </Select>
          )}
        </Field>
        <Field label="Start" hint={startIso ? `UTC ${startIso.replace('.000Z', 'Z')}` : 'Leave empty to unschedule'}>
          {(id) => <Input id={id} type="datetime-local" value={startLocal} onChange={(e) => setStartLocal(e.target.value)} />}
        </Field>
        <Field label="End" error={invalid ? 'End must be after start' : null} hint={endIso ? `UTC ${endIso.replace('.000Z', 'Z')}` : undefined}>
          {(id) => <Input id={id} type="datetime-local" value={endLocal} onChange={(e) => setEndLocal(e.target.value)} />}
        </Field>
        <Field label="Grace period (seconds)" hint="Time after start before being online counts as a violation.">
          {(id) => <Input id={id} type="number" min={0} max={3600} value={grace} onChange={(e) => setGrace(e.target.value)} />}
        </Field>
        <Field label="Heartbeat (seconds)" hint="How often the app logs a heartbeat. Gaps longer than 2× + 30 s are flagged.">
          {(id) => <Input id={id} type="number" min={10} max={600} value={heartbeat} onChange={(e) => setHeartbeat(e.target.value)} />}
        </Field>
        <div className="flex items-center gap-3 md:col-span-2">
          <Button variant="primary" type="submit" disabled={save.isPending || invalid}>
            {save.isPending && <Spinner />} Save schedule
          </Button>
          {saved && <span className="text-sm text-emerald-600">Saved</span>}
          {save.error && <Banner tone="error">{errorMessage(save.error)}</Banner>}
        </div>
      </form>
    </Card>
  );
}
