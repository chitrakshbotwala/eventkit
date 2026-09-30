import { z } from 'zod';
import { AttendeeStatusSchema, ComponentIdSchema, EmailSchema, IsoDateSchema } from './common';
import { ComplianceStatusSchema } from './phase2';

export const ScanBodySchema = z.object({
  payload: z.string().trim().min(1).max(512),
});
export type ScanBody = z.infer<typeof ScanBodySchema>;

export const ScanResultKindSchema = z.enum([
  'valid',
  'already_checked_in',
  'not_ready',
  'expired',
  'invalid',
]);
export type ScanResultKind = z.infer<typeof ScanResultKindSchema>;

export const ScanResponseSchema = z.object({
  result: ScanResultKindSchema,
  message: z.string(),
  attendee: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
  checkedInAt: IsoDateSchema.nullable(),
  checkedInBy: z.string().nullable(),
});
export type ScanResponse = z.infer<typeof ScanResponseSchema>;

export const ManualCheckinBodySchema = z.object({
  attendeeId: z.string().min(1),
  reason: z.string().trim().min(3).max(500),
});
export type ManualCheckinBody = z.infer<typeof ManualCheckinBodySchema>;

export const AttendeeUpsertBodySchema = z.object({
  email: EmailSchema,
  name: z.string().trim().min(1).max(200),
});
export type AttendeeUpsertBody = z.infer<typeof AttendeeUpsertBodySchema>;

export const AttendeeListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: z.union([AttendeeStatusSchema, z.literal('checked_in'), z.literal('all')]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
});
export type AttendeeListQuery = z.infer<typeof AttendeeListQuerySchema>;

export const AttendeeRowSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  status: AttendeeStatusSchema,
  checkedInAt: IsoDateSchema.nullable(),
  lastSeenAt: IsoDateSchema.nullable(),
  overallPercent: z.number().nullable(),
  deviceCount: z.number().int(),
  compliance: ComplianceStatusSchema.nullable(),
});
export type AttendeeRow = z.infer<typeof AttendeeRowSchema>;

export const AttendeeListResponseSchema = z.object({
  items: z.array(AttendeeRowSchema),
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
});
export type AttendeeListResponse = z.infer<typeof AttendeeListResponseSchema>;

export const ImportResultSchema = z.object({
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  duplicates: z.number().int(),
  errors: z.array(z.object({ line: z.number().int(), message: z.string() })),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

export const OverviewCountersSchema = z.object({
  rsvp: z.number().int(),
  loggedIn: z.number().int(),
  installing: z.number().int(),
  ready: z.number().int(),
  checkedIn: z.number().int(),
  compliant: z.number().int(),
  violations: z.number().int(),
  warnings: z.number().int(),
  unverified: z.number().int(),
});
export type OverviewCounters = z.infer<typeof OverviewCountersSchema>;

export const AttendanceRowSchema = z.object({
  attendeeId: z.string(),
  name: z.string(),
  email: z.string(),
  checkedInAt: IsoDateSchema,
  method: z.enum(['qr', 'manual']),
  scannerName: z.string().nullable(),
  scannerEmail: z.string().nullable(),
  reason: z.string().nullable(),
});
export type AttendanceRow = z.infer<typeof AttendanceRowSchema>;

export const SettingsSchema = z.object({
  pinnedFlutterVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .nullable(),
  mirrorBaseUrl: z.url().nullable(),
  minDiskGb: z.number().positive().max(500),
  minAppVersion: z.string(),
  components: z.object({
    android: z.boolean(),
    java: z.boolean(),
    chrome: z.boolean(),
    vscode: z.boolean(),
    warmup: z.boolean(),
  }),
  gradleWarmup: z.boolean(),
  androidPlatform: z.string().regex(/^platforms;android-[0-9A-Za-z.-]+$/),
  androidBuildTools: z.string().regex(/^build-tools;[0-9A-Za-z.-]+$/),
  androidNdk: z
    .string()
    .regex(/^ndk;[0-9.]+$/)
    .nullable(),
  starterProject: z
    .object({
      sha256: z.string(),
      size: z.number().int(),
      fileName: z.string(),
      projectName: z.string(),
      uploadedAt: IsoDateSchema,
    })
    .nullable(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const SettingsUpdateBodySchema = SettingsSchema.omit({ starterProject: true }).partial();
export type SettingsUpdateBody = z.infer<typeof SettingsUpdateBodySchema>;

export const ComplianceRowSchema = z.object({
  attendeeId: z.string(),
  name: z.string(),
  email: z.string(),
  deviceId: z.string().nullable(),
  status: ComplianceStatusSchema,
  flags: z.array(ComplianceStatusSchema),
  firstSeenOnline: IsoDateSchema.nullable(),
  totalOnlineSeconds: z.number(),
  onlineCount: z.number().int(),
  limitedSeconds: z.number(),
  gapSeconds: z.number(),
  lastEventAt: IsoDateSchema.nullable(),
  logVerified: z.boolean(),
  notes: z.array(z.string()),
});
export type ComplianceRow = z.infer<typeof ComplianceRowSchema>;

export const AuditLogRowSchema = z.object({
  id: z.string(),
  createdAt: IsoDateSchema,
  actorType: z.string(),
  actorId: z.string().nullable(),
  actorLabel: z.string().nullable(),
  action: z.string(),
  target: z.string().nullable(),
  data: z.unknown(),
  ip: z.string().nullable(),
});
export type AuditLogRow = z.infer<typeof AuditLogRowSchema>;

export const SetupProgressRowSchema = z.object({
  deviceId: z.string(),
  componentId: ComponentIdSchema,
  status: z.string(),
  step: z.string().nullable(),
  version: z.string().nullable(),
  percent: z.number().nullable(),
  message: z.string().nullable(),
  updatedAt: IsoDateSchema,
});
export type SetupProgressRow = z.infer<typeof SetupProgressRowSchema>;

/** Server-sent event names on /admin/stream. */
export type AdminStreamEvent =
  | { type: 'counters'; data: OverviewCounters }
  | { type: 'progress'; data: { attendeeId: string; overallPercent: number } }
  | { type: 'readiness'; data: { attendeeId: string; accepted: boolean } }
  | {
      type: 'checkin';
      data: { attendeeId: string; name: string; method: 'qr' | 'manual'; at: string };
    }
  | {
      type: 'connectivity';
      data: {
        attendeeId: string;
        name: string;
        deviceId: string;
        eventType: string;
        state?: string;
        at: string;
        source: 'realtime' | 'uploaded_log';
      };
    }
  | { type: 'schedule'; data: { version: number } };
