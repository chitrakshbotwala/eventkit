#!/usr/bin/env node
// Markdown summary of a real setup test result (apps/desktop/src/main/setup-test.ts),
// for the GitHub Actions job summary.
//
//   node scripts/setup-test-report.mjs <setup-result.json> >> "$GITHUB_STEP_SUMMARY"
import { existsSync, readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.log(
    '### Real setup test\n\nNo result was written: the app did not finish. See the job log.',
  );
  process.exit(0);
}
const r = JSON.parse(readFileSync(file, 'utf8'));
const icon = { verified: '✅', failed: '❌', skipped: '➖', disabled: '➖' };
const cell = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .slice(0, 300);

const out = [];
out.push(`### ${r.ok ? '✅' : '❌'} Real setup on ${r.platform}: ${r.minutes} min`);
out.push('');
out.push(
  `App ${r.version}, manifest \`${r.manifestId ?? 'none'}\`, installed to \`${r.installRoot ?? '?'}\``,
);
if (r.error) out.push('', `**Setup error:** ${cell(r.error)}`);
out.push('', '| Component | Result | Version | Detail |', '| --- | --- | --- | --- |');
for (const c of r.components ?? []) {
  out.push(
    `| ${c.id} | ${icon[c.status] ?? '•'} ${c.status} | ${cell(c.version)} | ${cell(c.error)} |`,
  );
}
if (r.readiness) {
  out.push(
    '',
    `**Server readiness rules:** ${r.readiness.passed ? 'would accept' : 'would reject'}`,
  );
  for (const reason of r.readiness.reasons ?? []) out.push(`- ${cell(reason)}`);
  if (r.readiness.warnings?.length) {
    out.push('', '<details><summary>Warnings</summary>', '');
    for (const w of r.readiness.warnings) out.push(`- ${cell(w)}`);
    out.push('', '</details>');
  }
}
if (r.doctor) {
  out.push(
    '',
    '<details><summary>flutter doctor -v</summary>',
    '',
    '```',
    r.doctor.trim(),
    '```',
    '',
    '</details>',
  );
}
if (!r.ok && r.log?.length) {
  out.push(
    '',
    '<details><summary>Last log lines</summary>',
    '',
    '```',
    ...r.log.slice(-80),
    '```',
    '',
    '</details>',
  );
}
console.log(out.join('\n'));
