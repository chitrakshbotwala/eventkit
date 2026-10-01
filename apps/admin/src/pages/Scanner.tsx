import { BrowserQRCodeReader, type IScannerControls } from '@zxing/browser';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { ScanResponse } from '@eventkit/shared';
import { AttendeeStatusBadge, SCAN_RESULT } from '../components/status';
import {
  Badge,
  Banner,
  Button,
  Card,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
} from '../components/ui';
import { api, errorMessage, type SearchHit } from '../lib/api';
import { fmtTime } from '../lib/format';
import { useAuth } from '../lib/auth';

const DEBOUNCE_MS = 3000;
const OVERLAY_MS = 2500;
const CAMERA_KEY = 'eventkit.scanner.camera';

const storage = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      // storage unavailable (private mode)
    }
  },
};

// ---------- audio feedback ----------

let audioCtx: AudioContext | null = null;
function beep(kind: 'green' | 'amber' | 'red') {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    const tones = kind === 'green' ? [880, 1320] : kind === 'amber' ? [660, 660] : [220, 180];
    const type: OscillatorType = kind === 'red' ? 'square' : 'sine';
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.16;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.15);
    });
  } catch {
    // audio is best-effort
  }
}

// ---------- feedback overlay ----------

interface Feedback {
  res: ScanResponse;
  at: number;
}

function Overlay({ fb, onClose }: { fb: Feedback; onClose: () => void }) {
  const meta = SCAN_RESULT[fb.res.result];
  const bg =
    meta.tone === 'green'
      ? 'bg-emerald-600'
      : meta.tone === 'amber'
        ? 'bg-amber-500'
        : 'bg-red-600';
  const icon = meta.tone === 'green' ? '✓' : meta.tone === 'amber' ? '!' : '✕';
  return (
    <div
      className={`fixed inset-0 z-50 flex cursor-pointer flex-col items-center justify-center p-8 text-center text-white ${bg}`}
      onClick={onClose}
      role="alert"
      aria-live="assertive"
    >
      <div className="animate-pop">
        <div className="mx-auto grid h-36 w-36 place-items-center rounded-full bg-white/20 text-8xl font-bold">
          {icon}
        </div>
        <div className="mt-6 text-5xl font-bold tracking-tight sm:text-6xl">{meta.label}</div>
        {fb.res.attendee && (
          <div className="mt-4 text-3xl font-semibold sm:text-4xl">{fb.res.attendee.name}</div>
        )}
        {fb.res.attendee && <div className="mt-1 text-lg opacity-90">{fb.res.attendee.email}</div>}
        <div className="mt-4 text-lg opacity-90">{fb.res.message}</div>
        {fb.res.result === 'already_checked_in' && fb.res.checkedInAt && (
          <div className="mt-2 text-lg opacity-90">
            First checked in at {fmtTime(fb.res.checkedInAt)}
            {fb.res.checkedInBy && ` by ${fb.res.checkedInBy}`}
          </div>
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 h-1.5 bg-white/30">
        <div
          className="animate-shrink h-full bg-white"
          style={{ animationDuration: `${OVERLAY_MS}ms` }}
        />
      </div>
      <div className="absolute bottom-4 text-sm opacity-75">Tap to dismiss</div>
    </div>
  );
}

// ---------- camera ----------

function Camera({ onScan, paused }: { onScan: (text: string) => void; paused: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controls = useRef<IScannerControls | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(() => storage.get(CAMERA_KEY) ?? '');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onScanRef = useRef(onScan);
  const pausedRef = useRef(paused);
  useEffect(() => {
    onScanRef.current = onScan;
    pausedRef.current = paused;
  });

  const stop = useCallback(() => {
    controls.current?.stop();
    controls.current = null;
    setRunning(false);
  }, []);

  const start = useCallback(
    async (id: string) => {
      stop();
      setError(null);
      if (!window.isSecureContext) {
        setError(
          'Camera access needs HTTPS (or localhost). Use a USB/Bluetooth scanner or open the admin over HTTPS.',
        );
        return;
      }
      try {
        const reader = new BrowserQRCodeReader(undefined, {
          delayBetweenScanAttempts: 150,
          delayBetweenScanSuccess: 600,
        });
        controls.current = await reader.decodeFromVideoDevice(
          id || undefined,
          videoRef.current!,
          (result) => {
            if (result && !pausedRef.current) onScanRef.current(result.getText());
          },
        );
        setRunning(true);
        const list = await BrowserQRCodeReader.listVideoInputDevices();
        setDevices(list);
      } catch (err) {
        setError(
          err instanceof Error ? `Camera unavailable: ${err.message}` : 'Camera unavailable',
        );
        setRunning(false);
      }
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return (
    <div>
      <div className="relative aspect-video overflow-hidden rounded-xl bg-slate-900">
        <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />
        {!running && (
          <div className="absolute inset-0 grid place-items-center text-sm text-slate-300">
            <Button variant="primary" size="lg" onClick={() => void start(deviceId)}>
              Start camera
            </Button>
          </div>
        )}
        {running && (
          <div className="pointer-events-none absolute inset-[18%] rounded-2xl border-4 border-white/70" />
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {devices.length > 1 && (
          <Select
            aria-label="Camera"
            value={deviceId}
            className="w-64"
            onChange={(e) => {
              setDeviceId(e.target.value);
              storage.set(CAMERA_KEY, e.target.value);
              void start(e.target.value);
            }}
          >
            <option value="">Default camera</option>
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Camera ${i + 1}`}
              </option>
            ))}
          </Select>
        )}
        {running && (
          <Button size="sm" onClick={stop}>
            Stop camera
          </Button>
        )}
      </div>
      {error && (
        <div className="mt-3">
          <Banner tone="warn">{error}</Banner>
        </div>
      )}
    </div>
  );
}

// ---------- page ----------

export function ScannerPage() {
  const { isSuperadmin } = useAuth();
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [recent, setRecent] = useState<Feedback[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hid, setHid] = useState('');
  const hidRef = useRef<HTMLInputElement>(null);
  const last = useRef<{ payload: string; at: number } | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [search, setSearch] = useState('');
  const [manualFor, setManualFor] = useState<SearchHit | null>(null);

  const show = useCallback((res: ScanResponse) => {
    const fb = { res, at: Date.now() };
    setFeedback(fb);
    setRecent((r) => [fb, ...r].slice(0, 25));
    beep(SCAN_RESULT[res.result].tone);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setFeedback(null), OVERLAY_MS);
  }, []);

  const submit = useCallback(
    async (raw: string) => {
      const payload = raw.trim();
      if (!payload) return;
      const now = Date.now();
      if (last.current && last.current.payload === payload && now - last.current.at < DEBOUNCE_MS)
        return;
      last.current = { payload, at: now };
      setBusy(true);
      setError(null);
      try {
        show(await api.scan(payload));
      } catch (err) {
        setError(errorMessage(err));
        beep('red');
      } finally {
        setBusy(false);
      }
    },
    [show],
  );

  // Keep the HID input focused so handheld scanners (keyboard wedge) always type into it.
  useEffect(() => {
    const t = setInterval(() => {
      const active = document.activeElement;
      const typingElsewhere =
        active &&
        active !== hidRef.current &&
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);
      if (!typingElsewhere && !manualFor) hidRef.current?.focus({ preventScroll: true });
    }, 500);
    return () => clearInterval(t);
  }, [manualFor]);

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );

  const onHid = (e: FormEvent) => {
    e.preventDefault();
    const value = hid;
    setHid('');
    void submit(value);
  };

  return (
    <>
      <PageHeader
        title="Check-in scanner"
        subtitle="Scan attendee QR codes with the camera or a USB/Bluetooth scanner."
      />
      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <div className="space-y-6">
          <Card title="Camera">
            <Camera onScan={(t) => void submit(t)} paused={Boolean(feedback)} />
          </Card>
          <Card title="Handheld scanner">
            <form onSubmit={onHid} className="flex gap-2">
              <Input
                ref={hidRef}
                aria-label="Scanner input"
                placeholder="Focus stays here: scan with a USB/Bluetooth scanner, or paste a code and press Enter"
                value={hid}
                onChange={(e) => setHid(e.target.value)}
                autoComplete="off"
                autoFocus
                className="font-mono"
              />
              <Button variant="primary" type="submit" disabled={busy || !hid.trim()}>
                {busy ? <Spinner /> : 'Check'}
              </Button>
            </form>
            {error && (
              <div className="mt-3">
                <Banner tone="error">{error}</Banner>
              </div>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          <ManualSearch
            search={search}
            setSearch={setSearch}
            canManual={isSuperadmin}
            onManual={setManualFor}
          />
          <Card title="Recent scans">
            {recent.length === 0 ? (
              <p className="text-sm text-slate-500">Nothing scanned yet.</p>
            ) : (
              <ul className="-my-2 divide-y divide-slate-100 dark:divide-slate-800">
                {recent.map((r) => {
                  const meta = SCAN_RESULT[r.res.result];
                  return (
                    <li key={r.at} className="flex items-center gap-3 py-2 text-sm">
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      <span className="min-w-0 flex-1 truncate">
                        {r.res.attendee?.name ?? r.res.message}
                      </span>
                      <span className="text-xs tabular-nums text-slate-400">
                        {new Date(r.at).toLocaleTimeString()}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
      {feedback && <Overlay fb={feedback} onClose={() => setFeedback(null)} />}
      <ManualCheckinDialog
        hit={manualFor}
        onClose={() => setManualFor(null)}
        onDone={(res) => {
          setManualFor(null);
          show(res);
        }}
      />
    </>
  );
}

function ManualSearch({
  search,
  setSearch,
  canManual,
  onManual,
}: {
  search: string;
  setSearch: (s: string) => void;
  canManual: boolean;
  onManual: (h: SearchHit) => void;
}) {
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const results = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.searchAttendees(q),
    enabled: q.length >= 2,
  });
  return (
    <Card title="Manual lookup">
      <Input
        type="search"
        aria-label="Search attendee"
        placeholder="Search by name or email…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="mt-3">
        {q.length < 2 ? (
          <p className="text-xs text-slate-500">Type at least 2 characters.</p>
        ) : results.isLoading ? (
          <Spinner />
        ) : results.error ? (
          <Banner tone="error">{errorMessage(results.error)}</Banner>
        ) : results.data!.items.length === 0 ? (
          <p className="text-sm text-slate-500">No match.</p>
        ) : (
          <ul className="-mb-2 divide-y divide-slate-100 dark:divide-slate-800">
            {results.data!.items.map((h) => (
              <li key={h.id} className="flex items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{h.name}</div>
                  <div className="truncate text-xs text-slate-500">{h.email}</div>
                </div>
                {h.checkedInAt ? (
                  <Badge tone="green">in at {fmtTime(h.checkedInAt)}</Badge>
                ) : (
                  <AttendeeStatusBadge status={h.status} />
                )}
                {canManual && !h.checkedInAt && (
                  <Button size="sm" onClick={() => onManual(h)}>
                    Check in
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {!canManual && (
        <p className="mt-3 text-xs text-slate-500">Manual check-in is restricted to organizers.</p>
      )}
    </Card>
  );
}

function ManualCheckinDialog({
  hit,
  onClose,
  onDone,
}: {
  hit: SearchHit | null;
  onClose: () => void;
  onDone: (r: ScanResponse) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason('');
    setError(null);
  }, [hit]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!hit) return;
    setBusy(true);
    try {
      onDone(await api.manualCheckin(hit.id, reason.trim()));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={Boolean(hit)} onClose={onClose} title={`Manual check-in: ${hit?.name ?? ''}`}>
      <form onSubmit={submit} className="space-y-4">
        <Banner tone="warn">
          Manual check-in bypasses the laptop readiness check. It is recorded in the audit log with
          your name.
        </Banner>
        <Field label="Reason (required)" hint="e.g. laptop battery died, QR app crashed">
          {(id) => (
            <Input
              id={id}
              required
              minLength={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={busy || reason.trim().length < 3}>
            {busy && <Spinner />} Check in
          </Button>
        </div>
      </form>
    </Modal>
  );
}
