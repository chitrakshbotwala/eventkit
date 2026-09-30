import { z } from 'zod';
import { ArchSchema, IsoDateSchema, PlatformSchema, Sha256HexSchema } from './common';

export const ArtifactKindSchema = z.enum([
  'zip',
  'tar.xz',
  'tar.gz',
  'exe',
  'msi',
  'dmg',
  'deb',
  'rpm',
  'pkg',
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

export const ArtifactSchema = z.object({
  /** Official upstream URL (HTTPS). */
  url: z.url(),
  /** Path relative to `mirrorBaseUrl`; clients try the mirror first when set. */
  mirrorPath: z.string().optional(),
  sha256: Sha256HexSchema,
  size: z.number().int().nonnegative().optional(),
  fileName: z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9._+-]+$/, 'fileName must be a plain file name'),
  kind: ArtifactKindSchema,
  /** Silent install args for executable installers. */
  installArgs: z.array(z.string()).default([]),
  /** True when upstream publishes no hash and the server computed it; upstream may drift. */
  hashFromMirror: z.boolean().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

const base = {
  name: z.string(),
  enabled: z.boolean(),
  required: z.boolean(),
};

export const SystemComponentSchema = z.object({
  id: z.literal('system'),
  ...base,
  minDiskGb: z.number().positive(),
});

export const LinuxDepsComponentSchema = z.object({
  id: z.literal('linux-deps'),
  ...base,
  /** Package lists keyed by package manager. */
  packages: z.object({
    apt: z.array(z.string()),
    dnf: z.array(z.string()),
    pacman: z.array(z.string()),
    zypper: z.array(z.string()),
  }),
});

export const GitComponentSchema = z.object({
  id: z.literal('git'),
  ...base,
  minVersion: z.string(),
  version: z.string().optional(),
  artifact: ArtifactSchema.optional(),
  wingetId: z.string().optional(),
});

export const FlutterComponentSchema = z.object({
  id: z.literal('flutter'),
  ...base,
  channel: z.literal('stable'),
  version: z.string(),
  dartVersion: z.string().optional(),
  pinned: z.boolean(),
  artifact: ArtifactSchema,
});

export const JavaComponentSchema = z.object({
  id: z.literal('java'),
  ...base,
  majorVersion: z.number().int(),
  version: z.string().optional(),
  artifact: ArtifactSchema,
});

export const AndroidComponentSchema = z.object({
  id: z.literal('android'),
  ...base,
  cmdlineTools: ArtifactSchema,
  /** sdkmanager package ids, e.g. "platform-tools", "platforms;android-36". */
  packages: z.array(z.string().regex(/^[A-Za-z0-9._;-]+$/)),
  acceptLicenses: z.boolean(),
});

export const ChromeComponentSchema = z.object({
  id: z.literal('chrome'),
  ...base,
  artifact: ArtifactSchema.optional(),
  wingetId: z.string().optional(),
});

export const VscodeComponentSchema = z.object({
  id: z.literal('vscode'),
  ...base,
  version: z.string().optional(),
  artifact: ArtifactSchema.optional(),
  wingetId: z.string().optional(),
  extensions: z.array(z.string().regex(/^[A-Za-z0-9-]+\.[A-Za-z0-9-]+$/)),
});

export const DevtoolsComponentSchema = z.object({
  id: z.literal('devtools'),
  ...base,
});

export const StarterProjectSchema = z.object({
  url: z.url(),
  sha256: Sha256HexSchema,
  size: z.number().int().nonnegative(),
  fileName: z.string().regex(/^[A-Za-z0-9._+-]+$/),
  /** Folder name the project is extracted into. */
  projectName: z.string().regex(/^[a-z][a-z0-9_]*$/),
});
export type StarterProject = z.infer<typeof StarterProjectSchema>;

export const WarmupComponentSchema = z.object({
  id: z.literal('warmup'),
  ...base,
  starter: StarterProjectSchema.nullable(),
  gradleWarmup: z.boolean(),
});

export const VerifyComponentSchema = z.object({
  id: z.literal('verify'),
  ...base,
});

export const ManifestComponentSchema = z.discriminatedUnion('id', [
  SystemComponentSchema,
  LinuxDepsComponentSchema,
  GitComponentSchema,
  FlutterComponentSchema,
  JavaComponentSchema,
  AndroidComponentSchema,
  ChromeComponentSchema,
  VscodeComponentSchema,
  DevtoolsComponentSchema,
  WarmupComponentSchema,
  VerifyComponentSchema,
]);
export type ManifestComponent = z.infer<typeof ManifestComponentSchema>;
export type ComponentOf<Id extends ManifestComponent['id']> = Extract<
  ManifestComponent,
  { id: Id }
>;

export const ManifestPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  /** Stable id of this manifest content (hash of resolved inputs). */
  manifestId: z.string(),
  issuedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
  event: z.object({ slug: z.string(), name: z.string() }),
  target: z.object({ os: PlatformSchema, arch: ArchSchema }),
  mirrorBaseUrl: z.url().nullable(),
  minAppVersion: z.string(),
  /** True when artifacts are placeholders only usable in --simulate mode. */
  placeholder: z.boolean(),
  components: z.array(ManifestComponentSchema),
});
export type ManifestPayload = z.infer<typeof ManifestPayloadSchema>;

export const SignedManifestSchema = z.object({
  alg: z.literal('Ed25519'),
  keyId: z.string(),
  /** base64 signature over canonicalJson(payload). */
  signature: z.string(),
  payload: z.unknown(),
});
export type SignedManifest = z.infer<typeof SignedManifestSchema>;

export const ManifestQuerySchema = z.object({
  os: PlatformSchema,
  arch: ArchSchema,
});

export function findComponent<Id extends ManifestComponent['id']>(
  manifest: Pick<ManifestPayload, 'components'>,
  id: Id,
): ComponentOf<Id> | undefined {
  return manifest.components.find((c) => c.id === id) as ComponentOf<Id> | undefined;
}
