import type { Arch, ArtifactKind, FlutterReleasesJson, Platform } from '@eventkit/shared';

export interface ResolvedArtifact {
  url: string;
  sha256: string;
  size?: number;
  fileName: string;
  kind: ArtifactKind;
  version: string;
  /** Upstream publishes no hash; we computed it from our mirror copy. */
  hashFromMirror?: boolean;
}

export interface ResolvedTarget {
  os: Platform;
  arch: Arch;
  git?: ResolvedArtifact;
  java: ResolvedArtifact;
  androidCmdlineTools: ResolvedArtifact;
  chrome?: ResolvedArtifact;
  chromeDeb?: ResolvedArtifact;
  chromeRpm?: ResolvedArtifact;
  vscode: ResolvedArtifact;
}

export interface ResolvedSet {
  resolvedAt: string;
  /** Stable-only release lists, so a pinned Flutter version can be selected offline. */
  flutterReleases: Partial<Record<Platform, FlutterReleasesJson>>;
  targets: Record<string, ResolvedTarget>;
  /** Suggestions from Flutter's FlutterExtension.kt for the current stable. */
  android?: { compileSdk?: number; ndkVersion?: string; flutterVersion?: string };
  /** Hashes computed per Flutter version (only needed for pinned versions lacking sha). */
  warnings: string[];
}

export const targetKey = (os: Platform, arch: Arch) => `${os}-${arch}`;

export const RESOLVED_KEY = 'manifest.resolved';
export const RESOLVE_STATUS_KEY = 'manifest.resolveStatus';

export interface ResolveStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  log: string[];
}
