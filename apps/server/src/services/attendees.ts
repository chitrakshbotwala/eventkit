import type { Attendance, Attendee } from '@prisma/client';
import type { AttendeeProfile, AttendeeStatus } from '@eventkit/shared';

export function toProfile(a: Attendee & { attendance?: Attendance | null }): AttendeeProfile {
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    status: a.status as AttendeeStatus,
    ready: a.status === 'ready' && Boolean(a.qrSecret),
    checkedInAt: a.attendance ? a.attendance.checkedInAt.toISOString() : null,
  };
}
