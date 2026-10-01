import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { ZodType } from 'zod';
import type { EventMap, IpcErrorPayload } from '../common/ipc';
import { ApiError } from './api';
import { logger } from './logger';
import { getMainWindow, isTrustedSender } from './window';

const log = logger.scope('ipc');

function toError(err: unknown): IpcErrorPayload {
  if (err instanceof ApiError) return { code: err.code, message: err.message };
  if (err instanceof Error)
    return { code: (err as { code?: string }).code ?? 'error', message: err.message };
  return { code: 'error', message: String(err) };
}

/**
 * Register an invoke handler. Every call is checked to come from our own
 * window/page, and its payload is validated before the handler runs.
 */
export function handle<T>(channel: string, schema: ZodType<T> | null, fn: (payload: T) => unknown) {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, arg: unknown) => {
    if (!isTrustedSender(event.sender, event.senderFrame?.url)) {
      log.warn(`rejected ${channel} from untrusted sender ${event.senderFrame?.url ?? '?'}`);
      return { ok: false, error: { code: 'forbidden', message: 'Untrusted sender' } };
    }
    let payload = arg as T;
    if (schema) {
      const parsed = schema.safeParse(arg);
      if (!parsed.success)
        return { ok: false, error: { code: 'invalid', message: 'Invalid request' } };
      payload = parsed.data;
    }
    try {
      return { ok: true, value: await fn(payload) };
    } catch (err) {
      return { ok: false, error: toError(err) };
    }
  });
}

export function send<E extends keyof EventMap>(event: E, payload: EventMap[E]) {
  const win = getMainWindow();
  if (win && !win.webContents.isDestroyed()) win.webContents.send(event, payload);
}
