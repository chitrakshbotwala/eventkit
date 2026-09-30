import { useCallback, useEffect, useState } from 'react';
import type { AppInfo, AuthState, LogLine, Phase2View, QrView, SetupSnapshot } from '@common/ipc';

export const ek = window.eventkit;

export function useAppInfo() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void ek.app.info().then(setInfo);
  }, []);
  return info;
}

export function useAuth() {
  const [state, setState] = useState<AuthState | null>(null);
  useEffect(() => {
    void ek.auth.state().then(setState);
    return ek.on('auth:changed', setState);
  }, []);
  return [state, setState] as const;
}

export function useSetup() {
  const [snap, setSnap] = useState<SetupSnapshot | null>(null);
  useEffect(() => {
    void ek.setup.snapshot().then(setSnap);
    return ek.on('setup:snapshot', setSnap);
  }, []);
  return snap;
}

export function useQr(enabled: boolean) {
  const [qr, setQr] = useState<QrView | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => void ek.qr.current().then((q) => alive && setQr(q));
    load();
    const off = ek.on('qr:changed', setQr);
    const t = setInterval(load, 5_000);
    return () => {
      alive = false;
      off();
      clearInterval(t);
    };
  }, [enabled]);
  return qr;
}

export function usePhase2() {
  const [p, setP] = useState<Phase2View | null>(null);
  useEffect(() => {
    void ek.phase2.state().then(setP);
    const off = ek.on('phase2:changed', setP);
    const t = setInterval(() => void ek.phase2.state().then(setP), 1_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  return p;
}

export function useLogs(open: boolean) {
  const [lines, setLines] = useState<LogLine[]>([]);
  useEffect(() => {
    if (!open) return;
    void ek.logs.recent().then(setLines);
    return ek.on('log:line', (l) => setLines((prev) => [...prev.slice(-1999), l]));
  }, [open]);
  return lines;
}

/** Run an async action, tracking busy state and error message. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runAction = useCallback(
    async (...args: A): Promise<R | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [fn],
  );
  return { run: runAction, busy, error, setError };
}

export function formatBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatEta(s?: number): string {
  if (s === undefined || !Number.isFinite(s)) return '';
  if (s < 60) return `${Math.ceil(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}
