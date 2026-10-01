import type {
  AdminLoginResponse,
  AdminUser,
  AttendanceRow,
  AttendeeListResponse,
  AuditLogRow,
  ComplianceRow,
  ImportResult,
  ManifestPayload,
  OverviewCounters,
  Schedule,
  ScanResponse,
  ScheduleUpdateBody,
  Settings,
  SettingsUpdateBody,
  TotpEnrollResponse,
} from '@eventkit/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();
/** Called whenever the server says the admin session is gone. */
export function onUnauthorized(fn: Listener) {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}

interface RequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  raw?: Blob | ArrayBuffer;
  contentType?: string;
  signal?: AbortSignal;
}

export async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) {
    headers['content-type'] = opts.contentType ?? 'application/octet-stream';
    body = opts.raw;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    throw new ApiError(
      0,
      'network',
      `Cannot reach the server (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (proxy error page)
  }
  if (!res.ok) {
    const e = (json ?? {}) as { error?: string; message?: string; details?: unknown };
    if (res.status === 401 && !path.startsWith('/admin/auth/login')) {
      for (const fn of unauthorizedListeners) fn();
    }
    throw new ApiError(
      res.status,
      e.error ?? 'http_error',
      e.message ?? `Request failed (${res.status})`,
      e.details,
    );
  }
  return json as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'You are not allowed to do that.';
    if (err.code === 'validation_error' && Array.isArray(err.details)) {
      const d = err.details as Array<{ path: string; message: string }>;
      return `${err.message}: ${d.map((x) => `${x.path || 'input'} ${x.message}`).join('; ')}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------- typed endpoints ----------

export interface AttendeeDetail {
  attendee: {
    id: string;
    email: string;
    name: string;
    status: string;
    readyAt: string | null;
    lastSeenAt: string | null;
    createdAt: string;
    hasQrSecret: boolean;
  };
  attendance: {
    checkedInAt: string;
    method: string;
    reason: string | null;
    scanner: { name: string; email: string } | null;
  } | null;
  devices: Array<{
    id: string;
    os: string;
    arch: string;
    osVersion: string;
    hostname: string | null;
    appVersion: string;
    overallPercent: number | null;
    firstSeenAt: string;
    lastSeenAt: string;
  }>;
  progress: Array<{
    deviceId: string;
    componentId: string;
    status: string;
    step: string | null;
    version: string | null;
    percent: number | null;
    message: string | null;
    updatedAt: string;
  }>;
  readiness: Array<{
    id: string;
    deviceId: string;
    accepted: boolean;
    reasons: string[];
    report: unknown;
    createdAt: string;
  }>;
  connectivity: Array<{
    id: string;
    deviceId: string;
    seq: number;
    type: string;
    at: string;
    data: { state?: string; interfaces?: string[]; hint?: string } | null;
    source: string;
    valid: boolean;
  }>;
  logs: Array<{
    deviceId: string;
    logId: string;
    entryCount: number;
    chainValid: boolean;
    errors: string[];
    uploadedAt: string;
    lastEntryAt: string | null;
  }>;
  compliance: ComplianceRow | null;
}

export interface SearchHit {
  id: string;
  name: string;
  email: string;
  status: string;
  checkedInAt: string | null;
}

export interface SignInInfo {
  /** 'google' when GOOGLE_CLIENT_ID/SECRET are set, 'dev' for the development page. */
  provider: 'google' | 'dev';
  /** Authorized redirect URI to register on the Google OAuth client. */
  redirectUri: string;
  /** Authorized JavaScript origin (not strictly needed, but Google asks). */
  origin: string;
}

export interface ResolveStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  log: string[];
  resolvedAt: string | null;
}

export interface FeedItem {
  id: string;
  attendeeId: string;
  name: string;
  deviceId: string;
  type: string;
  state?: string;
  at: string;
  source: 'realtime' | 'uploaded_log';
  valid: boolean;
}

const qs = (p: Record<string, string | number | undefined | null>) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(p))
    if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  login: (email: string, password: string, totp?: string) =>
    request<AdminLoginResponse>('/admin/auth/login', {
      body: { email, password, ...(totp ? { totp } : {}) },
    }),
  logout: () => request<{ ok: true }>('/admin/auth/logout', { method: 'POST' }),
  me: () => request<{ admin: AdminUser }>('/admin/auth/me'),
  totpEnroll: () => request<TotpEnrollResponse>('/admin/auth/totp/enroll', { method: 'POST' }),
  totpConfirm: (code: string) =>
    request<{ ok: true }>('/admin/auth/totp/confirm', { body: { code } }),
  totpDisable: (code: string) =>
    request<{ ok: true }>('/admin/auth/totp/disable', { body: { code } }),

  overview: () => request<{ counters: OverviewCounters; serverTime: number }>('/admin/overview'),

  attendees: (p: { q?: string; status?: string; page?: number; pageSize?: number }) =>
    request<AttendeeListResponse>(`/admin/attendees${qs(p)}`),
  searchAttendees: (q: string) =>
    request<{ items: SearchHit[] }>(`/admin/attendees/search${qs({ q })}`),
  attendee: (id: string) => request<AttendeeDetail>(`/admin/attendees/${encodeURIComponent(id)}`),
  createAttendee: (email: string, name: string) =>
    request<{ id: string }>('/admin/attendees', { body: { email, name } }),
  updateAttendee: (id: string, patch: { email?: string; name?: string }) =>
    request<{ ok: true }>(`/admin/attendees/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    }),
  deleteAttendee: (id: string) =>
    request<{ ok: true }>(`/admin/attendees/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  revokeQr: (id: string) =>
    request<{ ok: true }>(`/admin/attendees/${encodeURIComponent(id)}/revoke-qr`, {
      method: 'POST',
    }),
  importCsv: (csv: string) => request<ImportResult>('/admin/attendees/import', { body: { csv } }),

  scan: (payload: string) => request<ScanResponse>('/admin/scan', { body: { payload } }),
  manualCheckin: (attendeeId: string, reason: string) =>
    request<ScanResponse>('/admin/checkin/manual', { body: { attendeeId, reason } }),
  attendance: () => request<{ items: AttendanceRow[] }>('/admin/attendance'),

  schedule: () => request<{ schedule: Schedule; serverTime: number }>('/admin/schedule'),
  saveSchedule: (body: ScheduleUpdateBody) =>
    request<{ schedule: Schedule; serverTime: number }>('/admin/schedule', { method: 'PUT', body }),
  startNow: () =>
    request<{ schedule: Schedule; serverTime: number }>('/admin/schedule/start-now', {
      method: 'POST',
    }),
  endNow: () =>
    request<{ schedule: Schedule; serverTime: number }>('/admin/schedule/end-now', {
      method: 'POST',
    }),

  monitoring: () =>
    request<{ schedule: Schedule; serverTime: number; rows: ComplianceRow[] }>('/admin/monitoring'),
  feed: (limit = 200) => request<{ items: FeedItem[] }>(`/admin/monitoring/feed${qs({ limit })}`),

  settings: () =>
    request<{ settings: Settings; signIn: SignInInfo; resolve: ResolveStatus }>('/admin/settings'),
  saveSettings: (patch: SettingsUpdateBody) =>
    request<{ settings: Settings }>('/admin/settings', { method: 'PUT', body: patch }),
  resolveManifest: () =>
    request<{ started: boolean }>('/admin/settings/resolve-manifest', { method: 'POST' }),
  resolveStatus: () => request<ResolveStatus>('/admin/settings/resolve-status'),
  manifestPreview: () =>
    request<Record<string, ManifestPayload | { error: string }>>(
      '/admin/settings/manifest-preview',
    ),
  uploadStarter: (name: string, file: File) =>
    request<{ settings: Settings }>(`/admin/settings/starter-project${qs({ name })}`, {
      method: 'POST',
      raw: file,
      contentType: 'application/zip',
    }),
  removeStarter: () =>
    request<{ settings: Settings }>('/admin/settings/starter-project', { method: 'DELETE' }),

  users: () => request<{ items: AdminUser[] }>('/admin/users'),
  createUser: (body: { email: string; name: string; role: string; password: string }) =>
    request<{ user: AdminUser }>('/admin/users', { body }),
  updateUser: (
    id: string,
    patch: { name?: string; role?: string; disabled?: boolean; password?: string },
  ) =>
    request<{ user: AdminUser }>(`/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    }),
  audit: (p: { action?: string; before?: string; limit?: number }) =>
    request<{ items: AuditLogRow[] }>(`/admin/audit${qs(p)}`),
};

export const exportUrl = {
  attendance: (format: 'csv' | 'xlsx') => `/admin/attendance/export?format=${format}`,
  monitoring: (format: 'csv' | 'xlsx') => `/admin/monitoring/export?format=${format}`,
};
