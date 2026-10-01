import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { generateSigningKeyPair } from '@eventkit/shared/node';
import type { DeviceInfo } from '@eventkit/shared';
import { buildApp } from '../src/app';
import { loadEnv } from '../src/env';
import { hashPassword } from '../src/lib/passwords';
import { resetEventCache } from '../src/services/event';
import type { IdentityProvider } from '../src/services/google';
import { resetAdminLoginLimiter } from '../src/routes/admin/auth';
import { invalidateCompliance } from '../src/services/compliance';
import type { ManifestResolver } from '../src/services/manifest/resolver';

const DB_URL = `file:${resolve(__dirname, '../prisma/test.db').replace(/\\/g, '/')}`;
export const ADMIN_ORIGIN = 'http://admin.test';
export const keys = generateSigningKeyPair();

export interface TestApp {
  app: FastifyInstance;
  prisma: PrismaClient;
  clock: { now: number };
  close(): Promise<void>;
}

let shared: PrismaClient | null = null;

export async function makeApp(
  opts: {
    resolver?: ManifestResolver;
    identity?: IdentityProvider;
    env?: Record<string, string>;
  } = {},
): Promise<TestApp> {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    LOG_LEVEL: 'silent',
    MANIFEST_SIGNING_KEY: keys.privateKey,
    ADMIN_ORIGINS: ADMIN_ORIGIN,
    PUBLIC_BASE_URL: 'http://localhost:8080',
    DATA_DIR: mkdtempSync(join(tmpdir(), 'ek-test-')),
    ADMIN_STATIC_DIR: join(tmpdir(), 'ek-no-admin'),
    EVENT_SLUG: 'test-event',
    EVENT_NAME: 'Test Event',
    ...opts.env,
  });
  shared ??= new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const prisma = shared;
  await resetDb(prisma);
  const clock = { now: Date.UTC(2026, 9, 10, 8, 0, 0) };
  const app = await buildApp({
    env,
    prisma,
    logger: false,
    now: () => clock.now,
    resolver: opts.resolver,
    identity: opts.identity,
  });
  return { app, prisma, clock, close: () => app.close() };
}

export async function resetDb(prisma: PrismaClient) {
  resetEventCache();
  resetAdminLoginLimiter();
  invalidateCompliance();
  await prisma.$transaction([
    prisma.connectivityEvent.deleteMany(),
    prisma.connectivityLog.deleteMany(),
    prisma.attendance.deleteMany(),
    prisma.readinessReport.deleteMany(),
    prisma.setupProgress.deleteMany(),
    prisma.session.deleteMany(),
    prisma.device.deleteMany(),
    prisma.attendee.deleteMany(),
    prisma.schedule.deleteMany(),
    prisma.adminSession.deleteMany(),
    prisma.adminUser.deleteMany(),
    prisma.signInRequest.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.setting.deleteMany(),
    prisma.event.deleteMany(),
  ]);
}

export async function addAttendee(t: TestApp, email: string, name = 'Test Person') {
  const event = await t.app.ctx.event();
  return t.prisma.attendee.create({ data: { eventId: event.id, email, name } });
}

export const device = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  clientDeviceId: '3b241101-e2bb-4255-8caf-4136c566a962',
  os: 'windows',
  arch: 'x64',
  osVersion: 'Windows 11',
  hostname: 'laptop',
  appVersion: '0.1.0',
  ...over,
});

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export const LOOPBACK_PORT = 53682;

/** Start a sign-in like the desktop app does; returns the redirect (to Google or the dev page). */
export async function startSignIn(
  t: TestApp,
  over: { port?: number; challenge?: string; state?: string } = {},
) {
  const q = new URLSearchParams({
    port: String(over.port ?? LOOPBACK_PORT),
    challenge: over.challenge ?? pkce().challenge,
    state: over.state ?? 'app-state-0123456789',
  });
  return t.app.inject({ method: 'GET', url: `/auth/google/start?${q.toString()}` });
}

/** The OAuth `state` the server sent to the identity provider. */
export function providerState(start: LightMyRequestResponse): string {
  const state = new URL(String(start.headers.location), 'http://server.test').searchParams.get(
    'state',
  );
  if (!state) throw new Error(`no state in ${start.headers.location}`);
  return state;
}

/** Google redirecting the browser back to the server. */
export function callback(t: TestApp, params: Record<string, string>) {
  return t.app.inject({
    method: 'GET',
    url: `/auth/google/callback?${new URLSearchParams(params).toString()}`,
  });
}

/** Where the server sent the browser after the callback (the app's loopback listener). */
export const loopback = (res: LightMyRequestResponse) => new URL(String(res.headers.location));

/** Browser part of the sign-in using the development provider (any email). */
export async function browserSignIn(t: TestApp, email: string, challenge: string) {
  const start = await startSignIn(t, { challenge });
  const cont = await t.app.inject({
    method: 'GET',
    url: `/auth/google/dev/continue?${new URLSearchParams({ state: providerState(start), email }).toString()}`,
  });
  return t.app.inject({ method: 'GET', url: String(cont.headers.location) });
}

export function exchange(t: TestApp, code: string, verifier: string, dev: DeviceInfo = device()) {
  return t.app.inject({
    method: 'POST',
    url: '/auth/google/exchange',
    payload: { code, verifier, device: dev },
  });
}

/** Full attendee login; returns bearer token + device key. */
export async function loginAttendee(t: TestApp, email: string, dev: DeviceInfo = device()) {
  const { verifier, challenge } = pkce();
  const cb = await browserSignIn(t, email, challenge);
  const code = loopback(cb).searchParams.get('code');
  if (!code) throw new Error(`sign-in failed: ${String(cb.headers.location ?? cb.body)}`);
  const res = await exchange(t, code, verifier, dev);
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  return res.json() as {
    token: string;
    deviceKey: string;
    deviceId: string;
    attendee: { id: string };
  };
}

export async function addAdmin(
  t: TestApp,
  email: string,
  role: 'superadmin' | 'volunteer' = 'superadmin',
  password = 'correct-horse-battery',
) {
  return t.prisma.adminUser.create({
    data: { email, name: email.split('@')[0]!, role, passwordHash: await hashPassword(password) },
  });
}

/** Log an admin in and return a cookie header value. */
export async function loginAdmin(
  t: TestApp,
  email: string,
  password = 'correct-horse-battery',
  totp?: string,
) {
  const res = await t.app.inject({
    method: 'POST',
    url: '/admin/auth/login',
    headers: { origin: ADMIN_ORIGIN },
    payload: { email, password, ...(totp ? { totp } : {}) },
  });
  const cookie = res.cookies.find((c) => c.name === 'ek_admin');
  return { res, cookie: cookie ? `ek_admin=${cookie.value}` : '' };
}

export function adminHeaders(cookie: string) {
  return { cookie, origin: ADMIN_ORIGIN };
}

export const json = <T = Record<string, unknown>>(r: LightMyRequestResponse) => r.json() as T;
