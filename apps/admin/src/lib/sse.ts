import { useEffect, useRef, useState } from 'react';
import type { AdminStreamEvent } from '@eventkit/shared';

type EventType = AdminStreamEvent['type'];
type Handler = (e: AdminStreamEvent) => void;

const TYPES: EventType[] = ['counters', 'progress', 'readiness', 'checkin', 'connectivity', 'schedule'];

/**
 * One shared EventSource for the whole app (the browser limits connections per
 * origin). Components subscribe with useStream(); the connection is opened on
 * the first subscriber and closed when the last one leaves.
 */
class StreamHub {
  private es: EventSource | null = null;
  private handlers = new Set<Handler>();
  private statusListeners = new Set<(s: boolean) => void>();
  connected = false;

  subscribe(fn: Handler) {
    this.handlers.add(fn);
    this.open();
    return () => {
      this.handlers.delete(fn);
      if (this.handlers.size === 0) this.close();
    };
  }

  onStatus(fn: (s: boolean) => void) {
    this.statusListeners.add(fn);
    fn(this.connected);
    return () => {
      this.statusListeners.delete(fn);
    };
  }

  private setConnected(v: boolean) {
    this.connected = v;
    for (const fn of this.statusListeners) fn(v);
  }

  private open() {
    if (this.es) return;
    const es = new EventSource('/admin/stream', { withCredentials: true });
    this.es = es;
    es.onopen = () => this.setConnected(true);
    es.onerror = () => this.setConnected(false);
    for (const type of TYPES) {
      es.addEventListener(type, (ev) => {
        let data: unknown;
        try {
          data = JSON.parse((ev as MessageEvent<string>).data);
        } catch {
          return;
        }
        const event = { type, data } as AdminStreamEvent;
        for (const h of this.handlers) h(event);
      });
    }
  }

  private close() {
    this.es?.close();
    this.es = null;
    this.setConnected(false);
  }
}

export const streamHub = new StreamHub();

/** Subscribe to live admin events; the latest handler is always used. */
export function useStream(handler: Handler, enabled = true) {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    return streamHub.subscribe((e) => ref.current(e));
  }, [enabled]);
}

export function useStreamStatus() {
  const [connected, setConnected] = useState(streamHub.connected);
  useEffect(() => streamHub.onStatus(setConnected), []);
  return connected;
}
