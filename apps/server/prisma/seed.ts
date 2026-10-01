/**
 * Seed: event, superadmin + volunteer, sample RSVPs, sample phase-2 schedule, default settings.
 * Idempotent: safe to run repeatedly.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '../src/env';
import { hashPassword } from '../src/lib/passwords';
import { currentEvent } from '../src/services/event';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../src/services/settings';

const SAMPLE_RSVPS: Array<[string, string]> = [
  ['Asha Rao', 'asha@example.com'],
  ['Ben Okafor', 'ben@example.com'],
  ['Chen Wei', 'chen@example.com'],
  ['Diego Alvarez', 'diego@example.com'],
  ['Emma Schmidt', 'emma@example.com'],
  ['Farah Haddad', 'farah@example.com'],
  ['Gopal Iyer', 'gopal@example.com'],
  ['Hana Sato', 'hana@example.com'],
  ['Ivan Petrov', 'ivan@example.com'],
  ['Julia Costa', 'julia@example.com'],
  ['Dev Tester', 'dev@example.com'],
];

async function main() {
  const env = loadEnv();
  const prisma = new PrismaClient();
  try {
    const event = await currentEvent(prisma, env);
    console.log(`event: ${event.slug} (${event.name})`);

    const adminEmail = (env.SUPERADMIN_EMAIL ?? 'admin@example.org').toLowerCase();
    const adminPassword =
      env.SUPERADMIN_PASSWORD ?? (env.NODE_ENV === 'production' ? null : 'change-me-please-now');
    if (!adminPassword) throw new Error('SUPERADMIN_PASSWORD is required in production');
    const existing = await prisma.adminUser.findUnique({ where: { email: adminEmail } });
    if (!existing) {
      await prisma.adminUser.create({
        data: {
          email: adminEmail,
          name: 'Super Admin',
          role: 'superadmin',
          passwordHash: await hashPassword(adminPassword),
        },
      });
      console.log(`superadmin created: ${adminEmail}`);
    } else {
      console.log(`superadmin exists: ${adminEmail}`);
    }

    if (env.NODE_ENV !== 'production') {
      const volunteerEmail = 'volunteer@example.org';
      if (!(await prisma.adminUser.findUnique({ where: { email: volunteerEmail } }))) {
        await prisma.adminUser.create({
          data: {
            email: volunteerEmail,
            name: 'Door Volunteer',
            role: 'volunteer',
            passwordHash: await hashPassword('volunteer-dev-password'),
          },
        });
        console.log(`volunteer created: ${volunteerEmail} / volunteer-dev-password`);
      }

      for (const [name, email] of SAMPLE_RSVPS) {
        await prisma.attendee.upsert({
          where: { eventId_email: { eventId: event.id, email } },
          create: { eventId: event.id, email, name },
          update: {},
        });
      }
      console.log(`${SAMPLE_RSVPS.length} sample RSVPs upserted`);
    }

    const schedule = await prisma.schedule.findUnique({ where: { eventId: event.id } });
    if (!schedule) {
      const start = new Date();
      start.setUTCDate(start.getUTCDate() + 1);
      start.setUTCHours(10, 0, 0, 0);
      const end = new Date(start.getTime() + 4 * 3600_000);
      await prisma.schedule.create({
        data: {
          eventId: event.id,
          startAt: start,
          endAt: end,
          timezone: env.EVENT_TIMEZONE,
          mode: 'strict',
          graceSeconds: 120,
        },
      });
      console.log(`sample schedule: ${start.toISOString()} -> ${end.toISOString()}`);
    }

    const current = await getSettings(prisma);
    await saveSettings(prisma, {
      ...DEFAULT_SETTINGS,
      ...current,
      minAppVersion: env.MIN_APP_VERSION,
    });
    console.log('settings ok');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
