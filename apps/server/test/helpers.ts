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
import { resetOtpLimiter } from '../src/services/otp';
import { resetAdminLoginLimiter } from '../src/routes/admin/auth';
import { invalidateCompliance } from '../src/services/compliance';
import type { ManifestResolver } from '../src/services/manifest/resolver';

const DB_URL = `file:${resolve(__dirname, '../prisma/test.db').replace(/\\/g, '/')}`;
export const ADMIN_ORIGIN = 'http://admin.test';
export const keys = generateSigningKeyPair();

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface TestApp {
  app: FastifyInstance;
  prisma: PrismaClient;
  mails: Mail[];
  clock: { now: number };
  close(): Promise<void>;
}

let shared: PrismaClient | null = null;

export async function makeApp(
  opts: { resolver?: ManifestResolver; env?: Record<string, string> } = {},
): Promise<TestApp> {
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: DB_URL,
    LOG_LEVEL: 'silent',
    OTP_PEPPER: 'test-pepper-test-pepper',
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
  const mails: Mail[] = [];
  const clock = { now: Date.UTC(2026, 9, 10, 8, 0, 0) };
  const app = await buildApp({
    env,
    prisma,
    logger: false,
    now: () => clock.now,
    resolver: opts.resolver,
    mailer: {
      configured: true,
      send: async (to, subject, text) => {
        mails.push({ to, subject, text });
      },
      verify: async () => undefined,
    },
  });
  return { app, prisma, mails, clock, close: () => app.close() };
}

export async function resetDb(prisma: PrismaClient) {
  resetEventCache();
  resetOtpLimiter();
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
    prisma.otpCode.deleteMany(),
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

export function lastCode(t: TestApp, email: string): string {
  const mail = [...t.mails].reverse().find((m) => m.to === email);
  const code = mail && /\b(\d{6})\b/.exec(mail.subject)?.[1];
  if (!code) throw new Error(`no OTP mail for ${email}`);
  return code;
}

/** Full attendee login; returns bearer token + device key. */
export async function loginAttendee(t: TestApp, email: string, dev: DeviceInfo = device()) {
  await t.app.inject({ method: 'POST', url: '/auth/request-otp', payload: { email } });
  const res = await t.app.inject({
    method: 'POST',
    url: '/auth/verify-otp',
    payload: { email, code: lastCode(t, email), device: dev },
  });
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
