/**
 * Minimal, typed bridge. The renderer gets named functions only; no raw
 * ipcRenderer, no Node APIs. Every channel is fixed at build time.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, EVENT_NAMES, type EventKitApi, type EventMap } from '../common/ipc';

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (res.ok) return res.value;
  const err = new Error(res.error.message) as Error & { code?: string };
  err.code = res.error.code;
  throw err;
}

const api: EventKitApi = {
  app: {
    info: () => call(CHANNELS.appInfo),
    openExternal: (url) => call(CHANNELS.openExternal, url),
  },
  auth: {
    state: () => call(CHANNELS.authState),
    requestOtp: (email) => call(CHANNELS.requestOtp, { email }),
    verifyOtp: (email, code) => call(CHANNELS.verifyOtp, { email, code }),
    signOut: () => call(CHANNELS.signOut),
    refresh: () => call(CHANNELS.authRefresh),
  },
  setup: {
    snapshot: () => call(CHANNELS.setupSnapshot),
    start: () => call(CHANNELS.setupStart),
    retry: (componentId) => call(CHANNELS.setupRetry, { componentId }),
    cancel: () => call(CHANNELS.setupCancel),
    reverify: () => call(CHANNELS.setupReverify),
    repair: () => call(CHANNELS.setupRepair),
    copyDiagnostics: () => call(CHANNELS.copyDiagnostics),
  },
  qr: {
    current: () => call(CHANNELS.qrCurrent),
  },
  phase2: {
    state: () => call(CHANNELS.phase2State),
    sync: () => call(CHANNELS.phase2Sync),
  },
  tools: {
    openVsCode: () => call(CHANNELS.openVsCode),
    openProjectFolder: () => call(CHANNELS.openProjectFolder),
    runDoctor: () => call(CHANNELS.runDoctor),
  },
  logs: {
    recent: () => call(CHANNELS.logsRecent),
    openFolder: () => call(CHANNELS.logsOpenFolder),
  },
  on(event, cb) {
    if (!EVENT_NAMES.includes(event)) throw new Error(`unknown event ${String(event)}`);
    const listener = (_e: IpcRendererEvent, payload: EventMap[typeof event]) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
};

contextBridge.exposeInMainWorld('eventkit', api);
