import type { PrismaClient } from '@prisma/client';

export interface AuditEntry {
  actorType: 'admin' | 'attendee' | 'system';
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  target?: string | null;
  data?: Record<string, unknown>;
  ip?: string | null;
}

/** Append an audit record. Never pass secrets, OTPs or tokens in `data`. */
export async function audit(prisma: PrismaClient, e: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      actorLabel: e.actorLabel ?? null,
      action: e.action,
      target: e.target ?? null,
      data: JSON.stringify(e.data ?? {}),
      ip: e.ip ?? null,
    },
  });
}
