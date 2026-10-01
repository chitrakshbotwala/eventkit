import type { AdminStreamEvent } from '@eventkit/shared';

type Listener = (e: AdminStreamEvent) => void;

/** In-memory fan-out for the admin SSE stream (single server instance). */
export class Hub {
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  publish(e: AdminStreamEvent) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // a broken listener must not affect others
      }
    }
  }

  get size() {
    return this.listeners.size;
  }
}
