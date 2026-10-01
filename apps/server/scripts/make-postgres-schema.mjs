#!/usr/bin/env node
// Writes prisma/schema.postgres.prisma from schema.prisma with the provider set to postgresql.
// Deploy: DATABASE_URL=postgres://... prisma migrate deploy --schema prisma/schema.postgres.prisma
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../prisma');
const src = readFileSync(resolve(dir, 'schema.prisma'), 'utf8');
const out = src.replace(/provider\s*=\s*"sqlite"/, 'provider = "postgresql"');
if (out === src) throw new Error('sqlite provider line not found');
writeFileSync(
  resolve(dir, 'schema.postgres.prisma'),
  `// GENERATED from schema.prisma - do not edit\n${out}`,
);
console.log('wrote prisma/schema.postgres.prisma');
