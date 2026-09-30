import { z } from 'zod';
import { ARCHES, COMPONENT_IDS, PLATFORMS, ATTENDEE_STATUSES, ADMIN_ROLES } from '../constants';

export const PlatformSchema = z.enum(PLATFORMS);
export const ArchSchema = z.enum(ARCHES);
export const ComponentIdSchema = z.enum(COMPONENT_IDS);
export const AttendeeStatusSchema = z.enum(ATTENDEE_STATUSES);
export const AdminRoleSchema = z.enum(ADMIN_ROLES);

export const EmailSchema = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email())
  .transform((e) => e.toLowerCase());

export const IsoDateSchema = z.iso.datetime({ offset: true });
export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, 'expected lowercase sha256 hex');
export const Base64Schema = z.string().regex(/^[A-Za-z0-9+/_-]+={0,2}$/);

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
