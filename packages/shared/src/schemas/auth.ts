import { z } from 'zod';
import {
  AdminRoleSchema,
  ArchSchema,
  AttendeeStatusSchema,
  EmailSchema,
  IsoDateSchema,
  PlatformSchema,
} from './common';

export const RequestOtpBodySchema = z.object({ email: EmailSchema });
export type RequestOtpBody = z.infer<typeof RequestOtpBodySchema>;

export const RequestOtpResponseSchema = z.object({
  ok: z.literal(true),
  message: z.string(),
});
export type RequestOtpResponse = z.infer<typeof RequestOtpResponseSchema>;

export const DeviceInfoSchema = z.object({
  clientDeviceId: z.uuid(),
  os: PlatformSchema,
  arch: ArchSchema,
  osVersion: z.string().max(200),
  hostname: z.string().max(200).optional(),
  appVersion: z.string().max(50),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const VerifyOtpBodySchema = z.object({
  email: EmailSchema,
  code: z.string().regex(/^\d{6}$/),
  device: DeviceInfoSchema,
});
export type VerifyOtpBody = z.infer<typeof VerifyOtpBodySchema>;

export const AttendeeProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  status: AttendeeStatusSchema,
  ready: z.boolean(),
  checkedInAt: IsoDateSchema.nullable(),
});
export type AttendeeProfile = z.infer<typeof AttendeeProfileSchema>;

export const VerifyOtpResponseSchema = z.object({
  token: z.string(),
  expiresAt: IsoDateSchema,
  attendee: AttendeeProfileSchema,
  deviceId: z.string(),
  /** base64 device HMAC key; stored with safeStorage. */
  deviceKey: z.string(),
  serverTime: z.number(),
});
export type VerifyOtpResponse = z.infer<typeof VerifyOtpResponseSchema>;

export const MeResponseSchema = z.object({
  attendee: AttendeeProfileSchema,
  serverTime: z.number(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const TimeResponseSchema = z.object({ now: z.number() });
export type TimeResponse = z.infer<typeof TimeResponseSchema>;

// ---------- admin auth ----------

export const AdminLoginBodySchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(200),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type AdminLoginBody = z.infer<typeof AdminLoginBodySchema>;

export const AdminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: AdminRoleSchema,
  totpEnabled: z.boolean(),
  disabled: z.boolean(),
  lastLoginAt: IsoDateSchema.nullable(),
  createdAt: IsoDateSchema,
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminLoginResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), admin: AdminUserSchema }),
  z.object({ status: z.literal('totp_required') }),
]);
export type AdminLoginResponse = z.infer<typeof AdminLoginResponseSchema>;

export const AdminCreateUserBodySchema = z.object({
  email: EmailSchema,
  name: z.string().trim().min(1).max(100),
  role: AdminRoleSchema,
  password: z.string().min(10).max(200),
});
export type AdminCreateUserBody = z.infer<typeof AdminCreateUserBodySchema>;

export const AdminUpdateUserBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  role: AdminRoleSchema.optional(),
  disabled: z.boolean().optional(),
  password: z.string().min(10).max(200).optional(),
});
export type AdminUpdateUserBody = z.infer<typeof AdminUpdateUserBodySchema>;

export const TotpEnrollResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
});
export type TotpEnrollResponse = z.infer<typeof TotpEnrollResponseSchema>;

export const TotpConfirmBodySchema = z.object({ code: z.string().regex(/^\d{6}$/) });
