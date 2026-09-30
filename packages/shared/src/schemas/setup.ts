import { z } from 'zod';
import { ArchSchema, ComponentIdSchema, IsoDateSchema, PlatformSchema } from './common';

export const ComponentStatusSchema = z.enum([
  'pending',
  'running',
  'verified',
  'failed',
  'skipped',
  'disabled',
]);
export type ComponentStatus = z.infer<typeof ComponentStatusSchema>;

export const SetupStepSchema = z.enum([
  'detect',
  'download',
  'verify-hash',
  'install',
  'configure',
  'verify',
]);
export type SetupStep = z.infer<typeof SetupStepSchema>;

export const ProgressItemSchema = z.object({
  id: ComponentIdSchema,
  status: ComponentStatusSchema,
  step: SetupStepSchema.optional(),
  version: z.string().max(100).optional(),
  percent: z.number().min(0).max(100).optional(),
  message: z.string().max(500).optional(),
});
export type ProgressItem = z.infer<typeof ProgressItemSchema>;

export const ProgressBodySchema = z.object({
  overallPercent: z.number().min(0).max(100),
  items: z.array(ProgressItemSchema).max(20),
});
export type ProgressBody = z.infer<typeof ProgressBodySchema>;

// ---------- flutter doctor ----------

export const DoctorCategoryStatusSchema = z.enum(['ok', 'partial', 'missing', 'crash', 'unknown']);
export type DoctorCategoryStatus = z.infer<typeof DoctorCategoryStatusSchema>;

export const DoctorCategoryKeySchema = z.enum([
  'flutter',
  'windows',
  'android',
  'xcode',
  'chrome',
  'visual-studio',
  'android-studio',
  'vscode',
  'intellij',
  'linux-toolchain',
  'devices',
  'network',
  'proxy',
  'other',
]);
export type DoctorCategoryKey = z.infer<typeof DoctorCategoryKeySchema>;

export const DoctorCategorySchema = z.object({
  key: DoctorCategoryKeySchema,
  title: z.string(),
  status: DoctorCategoryStatusSchema,
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type DoctorCategory = z.infer<typeof DoctorCategorySchema>;

export const DoctorSummarySchema = z.object({
  flutterVersion: z.string().optional(),
  channel: z.string().optional(),
  dartVersion: z.string().optional(),
  categories: z.array(DoctorCategorySchema),
});
export type DoctorSummary = z.infer<typeof DoctorSummarySchema>;

// ---------- readiness ----------

export const ReadinessComponentSchema = z.object({
  id: ComponentIdSchema,
  status: ComponentStatusSchema,
  version: z.string().max(100).optional(),
  detail: z.string().max(500).optional(),
});
export type ReadinessComponent = z.infer<typeof ReadinessComponentSchema>;

export const ReadinessReportSchema = z.object({
  manifestId: z.string(),
  clientDeviceId: z.uuid(),
  generatedAt: IsoDateSchema,
  appVersion: z.string(),
  os: PlatformSchema,
  arch: ArchSchema,
  osVersion: z.string().max(200),
  components: z.array(ReadinessComponentSchema).max(20),
  doctor: DoctorSummarySchema,
});
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;

export const ReadinessBodySchema = z.object({
  report: ReadinessReportSchema,
  /** hex HMAC-SHA256(deviceKey, canonicalJson(report)) */
  signature: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ReadinessBody = z.infer<typeof ReadinessBodySchema>;

export const ReadinessResponseSchema = z.object({
  accepted: z.boolean(),
  reasons: z.array(z.string()),
  /** base64 per-attendee QR secret; only present when accepted. */
  qrSecret: z.string().optional(),
  attendeeId: z.string(),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
