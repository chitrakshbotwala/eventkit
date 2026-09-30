import { z } from 'zod';
import { IsoDateSchema, Sha256HexSchema } from './common';

export const PhaseModeSchema = z.enum(['strict', 'lenient']);
export type PhaseMode = z.infer<typeof PhaseModeSchema>;

export const ScheduleSchema = z.object({
  id: z.string(),
  /** Increments on every change; clients start a new log when it changes. */
  version: z.number().int(),
  startAt: IsoDateSchema.nullable(),
  endAt: IsoDateSchema.nullable(),
  timezone: z.string(),
  mode: PhaseModeSchema,
  graceSeconds: z.number().int().min(0).max(3600),
  heartbeatSeconds: z.number().int().min(10).max(600),
  preSyncMinutes: z.number().int().min(1).max(60),
  updatedAt: IsoDateSchema,
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const ScheduleResponseSchema = z.object({
  schedule: ScheduleSchema,
  serverTime: z.number(),
});
export type ScheduleResponse = z.infer<typeof ScheduleResponseSchema>;

export const ScheduleUpdateBodySchema = z
  .object({
    startAt: IsoDateSchema.nullable(),
    endAt: IsoDateSchema.nullable(),
    timezone: z.string().min(1).max(64),
    mode: PhaseModeSchema,
    graceSeconds: z.number().int().min(0).max(3600),
    heartbeatSeconds: z.number().int().min(10).max(600).optional(),
  })
  .refine((s) => !s.startAt || !s.endAt || Date.parse(s.endAt) > Date.parse(s.startAt), {
    message: 'endAt must be after startAt',
    path: ['endAt'],
  });
export type ScheduleUpdateBody = z.infer<typeof ScheduleUpdateBodySchema>;

export type PhaseState = 'none' | 'scheduled' | 'presync' | 'active' | 'ended';

// ---------- connectivity log ----------

export const LogEventTypeSchema = z.enum([
  'app_start',
  'app_stop',
  'heartbeat',
  'online',
  'limited',
  'offline',
  'clock_anomaly',
  'suspend',
  'resume',
  'phase_start',
  'phase_end',
]);
export type LogEventType = z.infer<typeof LogEventTypeSchema>;

export const NetStateSchema = z.enum(['online', 'limited', 'offline']);
export type NetState = z.infer<typeof NetStateSchema>;

export const LogEntryDataSchema = z
  .object({
    state: NetStateSchema.optional(),
    interfaces: z.array(z.string().max(64)).max(20).optional(),
    probes: z
      .array(
        z.object({
          target: z.string().max(200),
          ok: z.boolean(),
          status: z.number().int().optional(),
          ms: z.number().optional(),
          captive: z.boolean().optional(),
        }),
      )
      .max(10)
      .optional(),
    hint: z.string().max(200).optional(),
    wallDeltaMs: z.number().optional(),
    monoDeltaMs: z.number().optional(),
    appVersion: z.string().max(50).optional(),
    scheduleVersion: z.number().int().optional(),
  })
  .strict();
export type LogEntryData = z.infer<typeof LogEntryDataSchema>;

/** Fields covered by `hash`. */
export const LogEntryBodySchema = z.object({
  logId: z.uuid(),
  seq: z.number().int().nonnegative(),
  wallTime: z.number().int(),
  monoMs: z.number().nonnegative(),
  bootId: z.string().max(64),
  /** Client estimate of (serverTime - localTime) when the entry was written. */
  offsetMs: z.number().int(),
  type: LogEventTypeSchema,
  data: LogEntryDataSchema,
  prevHash: Sha256HexSchema,
});
export type LogEntryBody = z.infer<typeof LogEntryBodySchema>;

export const LogEntrySchema = LogEntryBodySchema.extend({
  hash: Sha256HexSchema,
  hmac: Sha256HexSchema,
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const ConnectivityEventsBodySchema = z.object({
  entries: z.array(LogEntrySchema).min(1).max(500),
});
export type ConnectivityEventsBody = z.infer<typeof ConnectivityEventsBodySchema>;

export const ConnectivityLogBodySchema = z.object({
  logId: z.uuid(),
  scheduleVersion: z.number().int(),
  entries: z.array(LogEntrySchema).max(50_000),
});
export type ConnectivityLogBody = z.infer<typeof ConnectivityLogBodySchema>;

export const ConnectivityAckSchema = z.object({
  accepted: z.number().int(),
  chainValid: z.boolean(),
  errors: z.array(z.string()),
  lastSeq: z.number().int().nullable(),
});
export type ConnectivityAck = z.infer<typeof ConnectivityAckSchema>;

export const ComplianceStatusSchema = z.enum([
  'compliant',
  'violation',
  'warning',
  'unverified',
  'monitoring_gap',
  'tampered',
]);
export type ComplianceStatus = z.infer<typeof ComplianceStatusSchema>;
