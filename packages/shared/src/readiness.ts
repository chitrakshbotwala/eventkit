import { evaluateDoctor } from './flutter/doctor';
import { findComponent, type ManifestPayload } from './schemas/manifest';
import type { ReadinessReport } from './schemas/setup';
import { compareVersions, majorOf, satisfiesMin } from './version';

export interface ReadinessEvaluation {
  passed: boolean;
  reasons: string[];
  warnings: string[];
}

/**
 * Authoritative readiness rules, shared by the desktop app (to decide when to
 * submit) and the server (to decide whether to release the QR secret).
 */
export function evaluateReadiness(
  report: ReadinessReport,
  manifest: ManifestPayload,
): ReadinessEvaluation {
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (report.os !== manifest.target.os || report.arch !== manifest.target.arch) {
    reasons.push(
      `report is for ${report.os}/${report.arch}, manifest for ${manifest.target.os}/${manifest.target.arch}`,
    );
  }
  if (compareVersions(report.appVersion, manifest.minAppVersion) < 0) {
    reasons.push(`app ${report.appVersion} is older than required ${manifest.minAppVersion}`);
  }

  const byId = new Map(report.components.map((c) => [c.id, c]));
  for (const comp of manifest.components) {
    if (!comp.enabled) continue;
    const got = byId.get(comp.id);
    if (!got || got.status !== 'verified') {
      reasons.push(
        `${comp.name}: ${got ? got.status : 'not reported'}${got?.detail ? ` (${got.detail})` : ''}`,
      );
    }
  }

  const flutter = findComponent(manifest, 'flutter');
  const flutterReported = byId.get('flutter')?.version ?? report.doctor.flutterVersion;
  if (flutter?.enabled) {
    if (!flutterReported) reasons.push('Flutter version unknown');
    else if (flutter.pinned && flutterReported !== flutter.version) {
      reasons.push(`Flutter ${flutterReported} installed, event requires ${flutter.version}`);
    }
    if (report.doctor.channel && report.doctor.channel !== 'stable') {
      reasons.push(`Flutter channel is ${report.doctor.channel}, expected stable`);
    }
  }

  const git = findComponent(manifest, 'git');
  if (git?.enabled && !satisfiesMin(byId.get('git')?.version, git.minVersion)) {
    reasons.push(`Git ${byId.get('git')?.version ?? 'unknown'} is older than ${git.minVersion}`);
  }

  const java = findComponent(manifest, 'java');
  if (java?.enabled) {
    const v = byId.get('java')?.version;
    const major = v ? majorOf(v) : undefined;
    if (major === undefined || major < java.majorVersion) {
      reasons.push(`Java ${v ?? 'unknown'} does not satisfy JDK ${java.majorVersion}`);
    }
  }

  const android = findComponent(manifest, 'android');
  const vscodeVerified = byId.get('vscode')?.status === 'verified';
  const doctor = evaluateDoctor(report.doctor, {
    androidRequired: Boolean(android?.enabled),
    vscodeVerifiedLocally: vscodeVerified,
  });
  for (const f of doctor.failures) reasons.push(`flutter doctor: ${f}`);
  warnings.push(...doctor.warnings);

  return { passed: reasons.length === 0, reasons, warnings };
}
