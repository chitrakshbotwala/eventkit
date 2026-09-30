import { parse as parseCsv } from 'csv-parse/sync';
import { EmailSchema, type ImportResult } from '@eventkit/shared';
import type { AppContext } from '../context';

const EMAIL_HEADERS = ['email', 'e-mail', 'email address', 'emailaddress', 'mail'];
const NAME_HEADERS = ['name', 'full name', 'fullname', 'attendee name', 'attendee'];
const FIRST_HEADERS = ['first name', 'firstname', 'given name'];
const LAST_HEADERS = ['last name', 'lastname', 'surname', 'family name'];

function findCol(headers: string[], candidates: string[]): number {
  return headers.findIndex((h) => candidates.includes(h.trim().toLowerCase()));
}

/**
 * Import an RSVP CSV (e.g. a Meetup / Luma / Google Forms export).
 * Upserts by case-insensitive email; duplicates inside the file are merged.
 * Recognised columns: email, name (or first/last name).
 */
export async function importRsvpCsv(ctx: AppContext, csv: string): Promise<ImportResult> {
  const rows = parseCsv(csv.charCodeAt(0) === 0xfeff ? csv.slice(1) : csv, {
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  }) as string[][];
  const result: ImportResult = { created: 0, updated: 0, skipped: 0, duplicates: 0, errors: [] };
  if (rows.length === 0) return result;

  const header = rows[0]!;
  let emailCol = findCol(header, EMAIL_HEADERS);
  const nameCol = findCol(header, NAME_HEADERS);
  const firstCol = findCol(header, FIRST_HEADERS);
  const lastCol = findCol(header, LAST_HEADERS);
  let dataRows = rows.slice(1);
  let lineOffset = 2;
  if (emailCol === -1) {
    // Header-less file: find a column that looks like an email in the first row.
    emailCol = header.findIndex((c) => EmailSchema.safeParse(c).success);
    if (emailCol === -1) {
      result.errors.push({ line: 1, message: 'no email column found' });
      return result;
    }
    dataRows = rows;
    lineOffset = 1;
  }

  const seen = new Map<string, string>();
  dataRows.forEach((row, i) => {
    const line = i + lineOffset;
    const parsed = EmailSchema.safeParse(row[emailCol] ?? '');
    if (!parsed.success) {
      result.skipped++;
      result.errors.push({
        line,
        message: `invalid email "${(row[emailCol] ?? '').slice(0, 80)}"`,
      });
      return;
    }
    const email = parsed.data;
    let name = nameCol >= 0 ? (row[nameCol] ?? '') : '';
    if (!name && (firstCol >= 0 || lastCol >= 0)) {
      name = [firstCol >= 0 ? row[firstCol] : '', lastCol >= 0 ? row[lastCol] : '']
        .filter(Boolean)
        .join(' ');
    }
    name = name.trim().slice(0, 200) || email.split('@')[0]!;
    if (seen.has(email)) result.duplicates++;
    seen.set(email, name);
  });

  const event = await ctx.event();
  const existing = await ctx.prisma.attendee.findMany({
    where: { eventId: event.id, email: { in: [...seen.keys()] } },
    select: { email: true, name: true },
  });
  const existingByEmail = new Map(existing.map((a) => [a.email, a.name]));

  for (const [email, name] of seen) {
    const prev = existingByEmail.get(email);
    if (prev === undefined) {
      await ctx.prisma.attendee.create({ data: { eventId: event.id, email, name } });
      result.created++;
    } else if (prev !== name) {
      await ctx.prisma.attendee.update({
        where: { eventId_email: { eventId: event.id, email } },
        data: { name },
      });
      result.updated++;
    } else {
      result.skipped++;
    }
  }
  return result;
}
