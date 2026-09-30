/**
 * Create or reset an admin user.
 * Usage: pnpm --filter @eventkit/server admin:create <email> <superadmin|volunteer> [name]
 * The password is read from ADMIN_PASSWORD or prompted on stdin (never passed as an argument).
 */
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { PrismaClient } from '@prisma/client';
import { AdminRoleSchema, EmailSchema } from '@eventkit/shared';
import { hashPassword } from '../src/lib/passwords';

async function main() {
  const [emailArg, roleArg, ...nameParts] = process.argv.slice(2);
  const email = EmailSchema.parse(emailArg);
  const role = AdminRoleSchema.parse(roleArg);
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    password = await rl.question('Password (min 10 chars): ');
    rl.close();
  }
  if (!password || password.length < 10) throw new Error('password must be at least 10 characters');
  const prisma = new PrismaClient();
  const passwordHash = await hashPassword(password);
  const name = nameParts.join(' ') || email.split('@')[0]!;
  await prisma.adminUser.upsert({
    where: { email },
    create: { email, role, name, passwordHash },
    update: { role, passwordHash, disabled: false },
  });
  await prisma.adminSession.deleteMany({ where: { admin: { email } } });
  await prisma.$disconnect();
  console.log(`admin ${email} (${role}) saved`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
