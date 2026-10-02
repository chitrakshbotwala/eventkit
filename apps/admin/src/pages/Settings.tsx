import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import type { AdminUser, AuditLogRow, Settings, SettingsUpdateBody } from '@eventkit/shared';
import {
  Badge,
  Banner,
  Button,
  Card,
  Empty,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  Toggle,
} from '../components/ui';
import { api, errorMessage, type SignInInfo } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDateTime, fmtRelative } from '../lib/format';

type Tab = 'toolchain' | 'manifest' | 'signin' | 'users' | 'account' | 'audit';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'toolchain', label: 'Toolchain' },
  { id: 'manifest', label: 'Manifest & starter project' },
  { id: 'signin', label: 'Attendee sign-in' },
  { id: 'users', label: 'Admin users' },
  { id: 'account', label: 'My account' },
  { id: 'audit', label: 'Audit log' },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('toolchain');
  const q = useQuery({ queryKey: ['settings'], queryFn: api.settings });

  return (
    <>
      <PageHeader title="Settings" subtitle="Event toolchain, manifest, users and security." />
      <div
        className="mb-6 flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800"
        role="tablist"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === t.id ? 'border-brand-600 text-brand-700 dark:text-brand-100' : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'users' ? (
        <UsersSection />
      ) : tab === 'account' ? (
        <AccountSection />
      ) : tab === 'audit' ? (
        <AuditSection />
      ) : q.isLoading ? (
        <Loading />
      ) : q.error ? (
        <Banner tone="error">{errorMessage(q.error)}</Banner>
      ) : tab === 'toolchain' ? (
        <ToolchainSection settings={q.data!.settings} />
      ) : tab === 'manifest' ? (
        <ManifestSection settings={q.data!.settings} />
      ) : (
        <SignInSection info={q.data!.signIn} />
      )}
    </>
  );
}

// ---------- toolchain ----------

function ToolchainSection({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const [form, setForm] = useState(settings);
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(settings), [settings]);

  const save = useMutation({
    mutationFn: (patch: SettingsUpdateBody) => api.saveSettings(patch),
    onSuccess: (d) => {
      qc.setQueryData(['settings'], (old: Awaited<ReturnType<typeof api.settings>> | undefined) =>
        old ? { ...old, settings: d.settings } : old,
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      pinnedFlutterVersion: form.pinnedFlutterVersion?.trim() || null,
      mirrorBaseUrl: form.mirrorBaseUrl?.trim() || null,
      minDiskGb: Number(form.minDiskGb),
      minAppVersion: form.minAppVersion.trim(),
      components: form.components,
      gradleWarmup: form.gradleWarmup,
      androidPlatform: form.androidPlatform.trim(),
      androidBuildTools: form.androidBuildTools.trim(),
      androidNdk: form.androidNdk?.trim() || null,
    });
  };
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const setComp = (k: keyof Settings['components'], v: boolean) =>
    setForm((f) => ({ ...f, components: { ...f.components, [k]: v } }));

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card title="Versions and downloads">
        <div className="grid gap-5 md:grid-cols-2">
          <Field
            label="Pinned Flutter version"
            hint="Everyone gets exactly this stable version. Empty = latest stable at resolve time."
          >
            {(id) => (
              <Input
                id={id}
                placeholder="e.g. 3.35.4"
                value={form.pinnedFlutterVersion ?? ''}
                onChange={(e) => set('pinnedFlutterVersion', e.target.value || null)}
              />
            )}
          </Field>
          <Field
            label="LAN mirror URL"
            hint="Clients try this first (e.g. http://10.0.0.5:8080/mirror). Files are SHA-256 verified, so HTTP is fine on the LAN."
          >
            {(id) => (
              <Input
                id={id}
                type="url"
                placeholder="http://10.0.0.5:8080/mirror"
                value={form.mirrorBaseUrl ?? ''}
                onChange={(e) => set('mirrorBaseUrl', e.target.value || null)}
              />
            )}
          </Field>
          <Field label="Minimum free disk (GB)">
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={500}
                step={0.5}
                value={form.minDiskGb}
                onChange={(e) => set('minDiskGb', Number(e.target.value))}
              />
            )}
          </Field>
          <Field label="Minimum desktop app version" hint="Older apps are refused at readiness.">
            {(id) => (
              <Input
                id={id}
                value={form.minAppVersion}
                onChange={(e) => set('minAppVersion', e.target.value)}
              />
            )}
          </Field>
        </div>
      </Card>
      <Card title="Components">
        <div className="grid gap-4 md:grid-cols-2">
          <Toggle
            checked={form.components.android}
            onChange={(v) => setComp('android', v)}
            label="Android SDK"
            description="cmdline-tools, platform-tools, platform + build-tools; license consent shown to attendees."
          />
          <Toggle
            checked={form.components.java}
            onChange={(v) => setComp('java', v)}
            label="Java (Temurin JDK 17)"
            description="Required for Android builds."
          />
          <Toggle
            checked={form.components.chrome}
            onChange={(v) => setComp('chrome', v)}
            label="Google Chrome"
            description="Flutter web + Chrome DevTools."
          />
          <Toggle
            checked={form.components.vscode}
            onChange={(v) => setComp('vscode', v)}
            label="VS Code + Dart/Flutter extensions"
          />
          <Toggle
            checked={form.components.warmup}
            onChange={(v) => setComp('warmup', v)}
            label="Offline warm-up"
            description="Starter project + pub cache for the offline phase."
          />
          <Toggle
            checked={form.gradleWarmup}
            onChange={(v) => set('gradleWarmup', v)}
            label="Gradle warm-up (flutter build apk --debug)"
            description="Large download (done at home during setup). Needed to build APKs at the venue without internet."
            disabled={!form.components.android}
          />
        </div>
      </Card>
      <Card title="Android packages">
        <div className="grid gap-5 md:grid-cols-3">
          <Field label="Platform">
            {(id) => (
              <Input
                id={id}
                value={form.androidPlatform}
                onChange={(e) => set('androidPlatform', e.target.value)}
              />
            )}
          </Field>
          <Field label="Build tools">
            {(id) => (
              <Input
                id={id}
                value={form.androidBuildTools}
                onChange={(e) => set('androidBuildTools', e.target.value)}
              />
            )}
          </Field>
          <Field label="NDK (optional)" hint="e.g. ndk;27.0.12077973">
            {(id) => (
              <Input
                id={id}
                value={form.androidNdk ?? ''}
                placeholder="not installed"
                onChange={(e) => set('androidNdk', e.target.value || null)}
              />
            )}
          </Field>
        </div>
      </Card>
      <div className="flex items-center gap-3">
        <Button variant="primary" type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner />} Save settings
        </Button>
        {saved && (
          <span className="text-sm text-emerald-600">
            Saved. New manifests are signed with these settings.
          </span>
        )}
      </div>
      {save.error && <Banner tone="error">{errorMessage(save.error)}</Banner>}
    </form>
  );
}

// ---------- manifest + starter ----------

function ManifestSection({ settings }: { settings: Settings }) {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['resolve-status'],
    queryFn: api.resolveStatus,
    refetchInterval: (query) => (query.state.data?.state === 'running' ? 2000 : false),
  });
  const resolve = useMutation({
    mutationFn: api.resolveManifest,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['resolve-status'] }),
  });
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.manifestPreview>> | null>(
    null,
  );
  const loadPreview = useMutation({ mutationFn: api.manifestPreview, onSuccess: setPreview });

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(settings.starterProject?.projectName ?? 'starter_app');
  const upload = useMutation({
    mutationFn: () => api.uploadStarter(name, file!),
    onSuccess: () => {
      setFile(null);
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });
  const remove = useMutation({
    mutationFn: api.removeStarter,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const st = status.data;

  return (
    <div className="space-y-6">
      <Card
        title="Setup manifest"
        actions={
          <>
            <Button onClick={() => loadPreview.mutate()} disabled={loadPreview.isPending}>
              {loadPreview.isPending && <Spinner />} Preview
            </Button>
            <Button
              variant="primary"
              onClick={() => resolve.mutate()}
              disabled={resolve.isPending || st?.state === 'running'}
            >
              {st?.state === 'running' && <Spinner />} Refresh from upstream
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Resolves the latest Flutter stable (or the pinned version), Temurin 17, Git, VS Code,
          Android command-line tools and Chrome, computes missing SHA-256 hashes by downloading into
          the server mirror, and signs per-platform manifests with Ed25519. This can take several
          minutes.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-slate-500">Last resolved:</span>
          <span className="font-medium">
            {st?.resolvedAt ? fmtDateTime(st.resolvedAt) : 'never (placeholder manifest in dev)'}
          </span>
          {st && (
            <Badge
              tone={
                st.state === 'done'
                  ? 'green'
                  : st.state === 'failed'
                    ? 'red'
                    : st.state === 'running'
                      ? 'blue'
                      : 'gray'
              }
            >
              {st.state}
            </Badge>
          )}
          {st?.message && <span className="text-xs text-slate-500">{st.message}</span>}
        </div>
        {st && st.log.length > 0 && (
          <pre className="mt-4 max-h-64 overflow-auto rounded-lg bg-slate-950 p-3 text-[11px] leading-relaxed text-slate-200">
            {st.log.slice(-80).join('\n')}
          </pre>
        )}
        {resolve.error && (
          <div className="mt-3">
            <Banner tone="error">{errorMessage(resolve.error)}</Banner>
          </div>
        )}
        {preview && (
          <div className="mt-5">
            <Table>
              <thead className="bg-slate-50 dark:bg-slate-800/50">
                <tr>
                  <Th>Target</Th>
                  <Th>Flutter</Th>
                  <Th>Components</Th>
                  <Th>Mirror</Th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {Object.entries(preview).map(([target, m]) => (
                  <tr key={target}>
                    <Td className="font-mono text-xs">{target}</Td>
                    {'error' in m ? (
                      <Td className="text-xs text-red-600" colSpan={3}>
                        {m.error}
                      </Td>
                    ) : (
                      <>
                        <Td className="text-xs">
                          {(() => {
                            const f = m.components.find((c) => c.id === 'flutter');
                            return f && f.id === 'flutter'
                              ? `${f.version}${f.pinned ? ' (pinned)' : ''}`
                              : '—';
                          })()}
                          {m.placeholder && (
                            <div>
                              <Badge tone="amber">placeholder</Badge>
                            </div>
                          )}
                        </Td>
                        <Td className="text-xs">
                          {m.components
                            .filter((c) => c.enabled)
                            .map((c) => c.id)
                            .join(', ')}
                        </Td>
                        <Td className="text-xs">{m.mirrorBaseUrl ?? '—'}</Td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </Card>

      <Card title="Starter project">
        <p className="text-sm text-slate-600 dark:text-slate-300">
          A zipped Flutter project attendees get during setup. The app runs{' '}
          <code>flutter pub get</code> and checks <code>pub get --offline</code>, so everything it
          depends on is cached for the offline phase.
        </p>
        {settings.starterProject ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-slate-50 px-4 py-3 text-sm dark:bg-slate-800/50">
            <Badge tone="green">uploaded</Badge>
            <span className="font-medium">{settings.starterProject.projectName}</span>
            <span className="text-xs text-slate-500">
              {(settings.starterProject.size / 1024).toFixed(0)} KB ·{' '}
              {fmtRelative(settings.starterProject.uploadedAt)} · sha256{' '}
              {settings.starterProject.sha256.slice(0, 12)}…
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto text-red-600"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              Remove
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            No starter uploaded: attendees get a fresh <code>flutter create</code> project instead.
          </p>
        )}
        <div className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <Field label="Project folder name" hint="snake_case, e.g. starter_app">
            {(id) => (
              <Input
                id={id}
                value={name}
                pattern="[a-z][a-z0-9_]*"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field label="Zip file">
            {(id) => (
              <input
                id={id}
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:font-medium file:text-brand-700"
              />
            )}
          </Field>
          <Button
            variant="primary"
            disabled={!file || !/^[a-z][a-z0-9_]*$/.test(name) || upload.isPending}
            onClick={() => upload.mutate()}
          >
            {upload.isPending && <Spinner />} Upload
          </Button>
        </div>
        {(upload.error || remove.error) && (
          <div className="mt-3">
            <Banner tone="error">{errorMessage(upload.error ?? remove.error)}</Banner>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------- attendee sign-in ----------

function SignInSection({ info }: { info: SignInInfo }) {
  return (
    <Card title="Attendee sign-in (Google)">
      <div className="mb-4 flex items-center gap-2 text-sm">
        Provider:{' '}
        {info.provider === 'google' ? (
          <Badge tone="green">Google</Badge>
        ) : (
          <Badge tone="amber">development page</Badge>
        )}
        {info.provider === 'dev' && (
          <span className="text-slate-500">
            GOOGLE_CLIENT_ID is not set, so attendees sign in on a test page that accepts any email.
            Production requires a Google OAuth client.
          </span>
        )}
      </div>
      <p className="mb-3 text-sm text-slate-600 dark:text-slate-400">
        Attendees click <b>Continue with Google</b> in the desktop app. Their Google account email
        must match their RSVP email (fix mismatches in Attendees by editing the email). No emails
        are sent.
      </p>
      <dl className="grid gap-3 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="font-medium">Authorized redirect URI</dt>
        <dd>
          <code className="break-all rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">
            {info.redirectUri}
          </code>
        </dd>
        <dt className="font-medium">Authorized JavaScript origin</dt>
        <dd>
          <code className="break-all rounded bg-slate-100 px-2 py-1 dark:bg-slate-800">
            {info.origin}
          </code>
        </dd>
      </dl>
      <p className="mt-3 text-xs text-slate-500">
        Google Cloud console → APIs &amp; Services → Credentials → Create OAuth client ID → Web
        application. Publish the OAuth consent screen (&quot;In production&quot;), otherwise only
        listed test users can sign in.
      </p>
    </Card>
  );
}

// ---------- users ----------

function UsersSection() {
  const qc = useQueryClient();
  const { admin: me } = useAuth();
  const users = useQuery({ queryKey: ['users'], queryFn: api.users });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const toggle = useMutation({
    mutationFn: (u: AdminUser) => api.updateUser(u.id, { disabled: !u.disabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['users'] }),
  });

  return (
    <Card
      title="Admin users"
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          Add user
        </Button>
      }
    >
      {users.isLoading ? (
        <Loading />
      ) : users.error ? (
        <Banner tone="error">{errorMessage(users.error)}</Banner>
      ) : (
        <Table>
          <thead className="bg-slate-50 dark:bg-slate-800/50">
            <tr>
              <Th>User</Th>
              <Th>Role</Th>
              <Th>2FA</Th>
              <Th>Last login</Th>
              <Th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {users.data!.items.map((u) => (
              <tr key={u.id} className={u.disabled ? 'opacity-60' : ''}>
                <Td>
                  <div className="font-medium">
                    {u.name}{' '}
                    {u.id === me?.id && <span className="text-xs text-slate-400">(you)</span>}
                  </div>
                  <div className="text-xs text-slate-500">{u.email}</div>
                </Td>
                <Td>
                  <Badge tone={u.role === 'superadmin' ? 'violet' : 'blue'}>{u.role}</Badge>
                  {u.disabled && (
                    <span className="ml-1">
                      <Badge tone="red">disabled</Badge>
                    </span>
                  )}
                </Td>
                <Td>{u.totpEnabled ? <Badge tone="green">on</Badge> : <Badge>off</Badge>}</Td>
                <Td className="text-xs text-slate-500">{fmtRelative(u.lastLoginAt)}</Td>
                <Td className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" onClick={() => setEditing(u)}>
                      Edit
                    </Button>
                    {u.id !== me?.id && (
                      <Button size="sm" variant="ghost" onClick={() => toggle.mutate(u)}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {toggle.error && (
        <div className="mt-6">
          <Banner tone="error">{errorMessage(toggle.error)}</Banner>
        </div>
      )}
      <UserDialog open={creating} onClose={() => setCreating(false)} />
      <UserDialog open={Boolean(editing)} user={editing} onClose={() => setEditing(null)} />
    </Card>
  );
}

function UserDialog({
  open,
  user,
  onClose,
}: {
  open: boolean;
  user?: AdminUser | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('volunteer');
  const [password, setPassword] = useState('');
  useEffect(() => {
    setEmail(user?.email ?? '');
    setName(user?.name ?? '');
    setRole(user?.role ?? 'volunteer');
    setPassword('');
  }, [user, open]);
  const save = useMutation({
    mutationFn: () =>
      user
        ? api.updateUser(user.id, { name: name.trim(), role, ...(password ? { password } : {}) })
        : api.createUser({ email: email.trim(), name: name.trim(), role, password }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });
  return (
    <Modal open={open} onClose={onClose} title={user ? `Edit ${user.email}` : 'Add admin user'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="space-y-4"
      >
        {!user && (
          <Field label="Email">
            {(id) => (
              <Input
                id={id}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
        )}
        <Field label="Name">
          {(id) => (
            <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
        <Field label="Role" hint="Volunteers can only scan QR codes and look up attendees.">
          {(id) => (
            <Select id={id} value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="volunteer">Volunteer (scan only)</option>
              <option value="superadmin">Superadmin (everything)</option>
            </Select>
          )}
        </Field>
        <Field
          label={user ? 'New password (optional)' : 'Password'}
          hint="At least 10 characters. Changing it signs the user out everywhere."
        >
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              minLength={10}
              required={!user}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
        {save.error && <Banner tone="error">{errorMessage(save.error)}</Banner>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={save.isPending}>
            {save.isPending && <Spinner />} Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- account / 2FA ----------

function AccountSection() {
  const { admin, refresh } = useAuth();
  const [enroll, setEnroll] = useState<{ secret: string; otpauthUrl: string; qr: string } | null>(
    null,
  );
  const [code, setCode] = useState('');
  const start = useMutation({
    mutationFn: api.totpEnroll,
    onSuccess: async (r) =>
      setEnroll({ ...r, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 220 }) }),
  });
  const confirm = useMutation({
    mutationFn: () => api.totpConfirm(code),
    onSuccess: async () => {
      setEnroll(null);
      setCode('');
      await refresh();
    },
  });
  const disable = useMutation({
    mutationFn: () => api.totpDisable(code),
    onSuccess: async () => {
      setCode('');
      await refresh();
    },
  });

  return (
    <Card title="Two-factor authentication">
      {admin?.totpEnabled ? (
        <div className="space-y-4">
          <Banner tone="success">
            Two-factor authentication is on. You need your authenticator code to sign in.
          </Banner>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              disable.mutate();
            }}
            className="flex flex-wrap items-end gap-3"
          >
            <div className="w-48">
              <Field label="Current code">
                {(id) => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  />
                )}
              </Field>
            </div>
            <Button
              variant="danger"
              type="submit"
              disabled={code.length !== 6 || disable.isPending}
            >
              Disable 2FA
            </Button>
          </form>
          {disable.error && <Banner tone="error">{errorMessage(disable.error)}</Banner>}
        </div>
      ) : enroll ? (
        <div className="grid gap-6 md:grid-cols-[220px_1fr]">
          <img
            src={enroll.qr}
            alt="Authenticator setup QR code"
            className="h-[220px] w-[220px] rounded-lg bg-white p-2 ring-1 ring-slate-200"
          />
          <div className="space-y-4 text-sm">
            <p>Scan with Google Authenticator, 1Password, Authy, … or enter the key manually:</p>
            <code className="block break-all rounded bg-slate-100 px-3 py-2 font-mono text-sm dark:bg-slate-800">
              {enroll.secret}
            </code>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                confirm.mutate();
              }}
              className="flex flex-wrap items-end gap-3"
            >
              <div className="w-48">
                <Field label="Code from the app">
                  {(id) => (
                    <Input
                      id={id}
                      inputMode="numeric"
                      maxLength={6}
                      autoFocus
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    />
                  )}
                </Field>
              </div>
              <Button
                variant="primary"
                type="submit"
                disabled={code.length !== 6 || confirm.isPending}
              >
                Enable
              </Button>
              <Button onClick={() => setEnroll(null)}>Cancel</Button>
            </form>
            {confirm.error && <Banner tone="error">{errorMessage(confirm.error)}</Banner>}
          </div>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-slate-600 dark:text-slate-300">
            Protect your organizer account with a time-based one-time code (RFC 6238).
          </p>
          <Button variant="primary" onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending && <Spinner />} Set up 2FA
          </Button>
          {start.error && <Banner tone="error">{errorMessage(start.error)}</Banner>}
        </div>
      )}
    </Card>
  );
}

// ---------- audit ----------

function AuditSection() {
  const [action, setAction] = useState('');
  const [items, setItems] = useState<AuditLogRow[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<AuditLogRow | null>(null);

  const load = async (reset: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const before = reset ? undefined : items[items.length - 1]?.createdAt;
      const res = await api.audit({ action: action.trim() || undefined, before, limit: 100 });
      setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
      setDone(res.items.length < 100);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card
      title="Audit log"
      actions={
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load(true);
          }}
          className="flex gap-2"
        >
          <Input
            aria-label="Action prefix"
            placeholder="action prefix, e.g. scan."
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="w-56"
          />
          <Button type="submit">Filter</Button>
        </form>
      }
    >
      {error && <Banner tone="error">{error}</Banner>}
      {items.length === 0 && !loading ? (
        <Empty title="No audit entries" />
      ) : (
        <Table>
          <thead className="bg-slate-50 dark:bg-slate-800/50">
            <tr>
              <Th>Time</Th>
              <Th>Action</Th>
              <Th>Actor</Th>
              <Th>Target</Th>
              <Th>IP</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((r) => (
              <tr
                key={r.id}
                className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/40"
                onClick={() => setDetail(r)}
              >
                <Td className="whitespace-nowrap text-xs tabular-nums">
                  {fmtDateTime(r.createdAt)}
                </Td>
                <Td className="font-mono text-xs">{r.action}</Td>
                <Td className="text-xs">
                  {r.actorLabel ??
                    (r.actorId ? `${r.actorType}:${r.actorId.slice(-8)}` : r.actorType)}
                </Td>
                <Td className="font-mono text-xs text-slate-500">
                  {r.target ? r.target.slice(-10) : ''}
                </Td>
                <Td className="text-xs text-slate-500">{r.ip}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <div className="mt-8 flex justify-center">
        {loading ? (
          <Spinner />
        ) : (
          !done &&
          items.length > 0 && (
            <Button size="sm" onClick={() => void load(false)}>
              Load more
            </Button>
          )
        )}
      </div>
      <Modal
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        title={detail?.action ?? ''}
        wide
      >
        <pre className="overflow-auto rounded-lg bg-slate-950 p-3 text-xs text-slate-200">
          {JSON.stringify(detail, null, 2)}
        </pre>
      </Modal>
    </Card>
  );
}
