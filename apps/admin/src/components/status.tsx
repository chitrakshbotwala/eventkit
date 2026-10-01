import type { AttendeeStatus, ComplianceStatus, ScanResultKind } from '@eventkit/shared';
import { Badge, type Tone } from './ui';

export const ATTENDEE_STATUS: Record<AttendeeStatus, { label: string; tone: Tone }> = {
  invited: { label: 'Invited', tone: 'gray' },
  logged_in: { label: 'Logged in', tone: 'blue' },
  installing: { label: 'Installing', tone: 'amber' },
  ready: { label: 'Ready', tone: 'green' },
  not_ready: { label: 'Needs repair', tone: 'red' },
};

export function AttendeeStatusBadge({ status }: { status: string }) {
  const s = ATTENDEE_STATUS[status as AttendeeStatus] ?? { label: status, tone: 'gray' as Tone };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export const COMPLIANCE: Record<ComplianceStatus, { label: string; tone: Tone; help: string }> = {
  compliant: { label: 'Compliant', tone: 'green', help: 'Verified log covers the whole window and never reached the internet.' },
  violation: { label: 'Violation', tone: 'red', help: 'The internet was reachable during the offline window.' },
  warning: { label: 'Warning', tone: 'amber', help: 'Network interface up without internet (strict mode), or clock anomalies.' },
  unverified: { label: 'Unverified', tone: 'gray', help: 'No verified log uploaded yet: cannot be assumed compliant.' },
  monitoring_gap: { label: 'Monitoring gap', tone: 'violet', help: 'The app was not running (or silent) for part of the window.' },
  tampered: { label: 'Tampered chain', tone: 'red', help: 'The uploaded log failed hash-chain / HMAC verification.' },
};

export function ComplianceBadge({ status }: { status: ComplianceStatus | null | undefined }) {
  if (!status) return <span className="text-xs text-slate-400">—</span>;
  const c = COMPLIANCE[status];
  return (
    <Badge tone={c.tone} title={c.help}>
      {status === 'tampered' && '⚠ '}
      {c.label}
    </Badge>
  );
}

export const SCAN_RESULT: Record<ScanResultKind, { label: string; tone: 'green' | 'amber' | 'red' }> = {
  valid: { label: 'Checked in', tone: 'green' },
  already_checked_in: { label: 'Already checked in', tone: 'amber' },
  not_ready: { label: 'Setup not complete', tone: 'red' },
  expired: { label: 'QR expired', tone: 'amber' },
  invalid: { label: 'Invalid QR', tone: 'red' },
};

const COMPONENT_STATUS_TONE: Record<string, Tone> = {
  verified: 'green',
  running: 'blue',
  pending: 'gray',
  failed: 'red',
  skipped: 'gray',
  disabled: 'gray',
};

export function ComponentStatusBadge({ status }: { status: string }) {
  return <Badge tone={COMPONENT_STATUS_TONE[status] ?? 'gray'}>{status}</Badge>;
}
