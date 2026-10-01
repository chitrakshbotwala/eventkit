import { z } from 'zod';
import {
  AdminRoleSchema,
  ArchSchema,
  AttendeeStatusSchema,
  EmailSchema,
  IsoDateSchema,
  PlatformSchema,
} from './common';

export const DeviceInfoSchema = z.object({
  clientDeviceId: z.uuid(),
  os: PlatformSchema,
  arch: ArchSchema,
  osVersion: z.string().max(200),
  hostname: z.string().max(200).optional(),
  appVersion: z.string().max(50),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

/** base64url without padding, as used for PKCE verifiers/challenges and random tokens. */
const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * GET /auth/google/start: the desktop app opens this in the system browser.
 * `port` is its loopback listener, `challenge` = base64url(sha256(verifier)) (PKCE S256)
 * and `state` is echoed back to the listener.
 */
export const SignInStartQuerySchema = z.object({
  port: z.coerce.number().int().min(1024).max(65535),
  challenge: z.string().length(43).regex(B64URL),
  state: z.string().min(16).max(128).regex(B64URL),
});
export type SignInStartQuery = z.infer<typeof SignInStartQuerySchema>;

/** POST /auth/google/exchange: redeem the one-time code with the PKCE verifier. */
export const SignInExchangeBodySchema = z.object({
  code: z.string().min(32).max(128).regex(B64URL),
  verifier: z.string().min(43).max(128).regex(B64URL),
  device: DeviceInfoSchema,
});
export type SignInExchangeBody = z.infer<typeof SignInExchangeBodySchema>;

/** Error codes the server hands to the desktop app's loopback listener. */
export const SignInErrorCodeSchema = z.enum([
  'not_registered',
  'email_unverified',
  'cancelled',
  'expired',
  'failed',
]);
export type SignInErrorCode = z.infer<typeof SignInErrorCodeSchema>;

export const AttendeeProfileSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  status: AttendeeStatusSchema,
  ready: z.boolean(),
  checkedInAt: IsoDateSchema.nullable(),
});
export type AttendeeProfile = z.infer<typeof AttendeeProfileSchema>;

export const SignInResponseSchema = z.object({
  token: z.string(),
  expiresAt: IsoDateSchema,
  attendee: AttendeeProfileSchema,
  deviceId: z.string(),
  /** base64 device HMAC key; stored with safeStorage. */
  deviceKey: z.string(),
  serverTime: z.number(),
});
export type SignInResponse = z.infer<typeof SignInResponseSchema>;

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
