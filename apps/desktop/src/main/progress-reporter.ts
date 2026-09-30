import type { ProgressBody } from '@eventkit/shared';
import type { SetupSnapshot } from '../common/ipc';
import { api } from './api';
import { auth } from './auth';
import { errMsg, logger } from './logger';

const log = logger.scope('progress');

/** Mirrors setup progress to the admin live view (throttled, best effort). */
export class ProgressReporter {
  private last: string | null = null;
  private pending: SetupSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight = false;

  push(s: SetupSnapshot, immediate = false) {
    this.pending = s;
    if (immediate) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 5_000);
  }

  private async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const s = this.pending;
    if (!s || this.inflight || !auth.state().signedIn || s.components.length === 0) return;
    const body: ProgressBody = {
      overallPercent: Math.min(100, Math.max(0, s.overallPercent)),
      items: s.components.map((c) => ({
        id: c.id,
        status: c.status,
        step: c.step,
        version: c.version?.slice(0, 100),
        percent: Math.round(c.percent),
        message: (c.error ?? c.message)?.slice(0, 500),
      })),
    };
    const key = JSON.stringify(body);
    if (key === this.last) return;
    this.inflight = true;
    try {
      await api.request('/api/progress', null, { body, auth: true, timeoutMs: 10_000 });
      this.last = key;
    } catch (err) {
      log.debug(`progress report failed: ${errMsg(err)}`);
    } finally {
      this.inflight = false;
    }
  }
}
