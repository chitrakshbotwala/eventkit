#!/usr/bin/env node
// Builds the deployment branches from `main`:
//   server   packages/shared + apps/server + apps/admin + deploy/   (runs on the VPS)
//   desktop  packages/shared + apps/desktop + release workflow      (installers via GitHub Actions)
//
// Each sync adds one commit on top of the branch's previous head (never a force push), so a
// VPS can `git pull --ff-only`. Never commit to these branches directly; change `main`.
//
// Usage: node scripts/split-branches.mjs [--source main] [--label main] [--remote origin] [--push]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const source = arg('source', 'main');
const label = arg('label', source);
const remote = arg('remote', 'origin');
const push = process.argv.includes('--push');

const TARGETS = [
  {
    branch: 'server',
    drop: ['apps/desktop', '.github', 'scripts/split-branches.mjs'],
    about:
      'What runs on the VPS: the Fastify server, the admin site it serves, the shared package and deploy/ (Caddy, systemd, update and backup scripts). See README → "Deploying the server".',
  },
  {
    branch: 'desktop',
    drop: [
      'apps/server',
      'apps/admin',
      'deploy',
      '.github/workflows/ci.yml',
      '.github/workflows/split.yml',
      'scripts/split-branches.mjs',
    ],
    about:
      'The Electron desktop app and the shared package. Releases are built from main with the "Release desktop app" workflow (.github/workflows/release.yml). See README → "Releasing the desktop app".',
  },
];

// execFileSync returns null when stdout is inherited (e.g. for `git push`).
const git = (args, opts = {}) =>
  (
    execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
      ...opts,
    }) ?? ''
  ).trim();
const tryGit = (args) => {
  try {
    return git(args, { stdio: ['pipe', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

const sourceSha = git(['rev-parse', '--verify', `${source}^{commit}`]);
const short = sourceSha.slice(0, 7);
const tmp = mkdtempSync(join(tmpdir(), 'ek-split-'));

// Build on top of the published branch heads, so every push is a fast-forward.
if (push) {
  tryGit([
    'fetch',
    remote,
    ...TARGETS.map((t) => `+refs/heads/${t.branch}:refs/remotes/${remote}/${t.branch}`),
  ]);
}

try {
  for (const t of TARGETS) {
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, `${t.branch}.index`) };
    const g = (args, input) => git(args, { env, input });
    g(['read-tree', sourceSha]);
    g(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...t.drop]);
    const note = `# \`${t.branch}\` branch\n\nGenerated from \`${label}\` (${short}) by \`scripts/split-branches.mjs\`. Do not commit here: change \`${label}\` and the branch is re-synced automatically.\n\n${t.about}\n`;
    const blob = g(['hash-object', '-w', '--stdin'], note);
    g(['update-index', '--add', '--cacheinfo', `100644,${blob},BRANCH.md`]);
    const tree = g(['write-tree']);

    const published = tryGit(['rev-parse', '--verify', `refs/remotes/${remote}/${t.branch}`]);
    const parent = published ?? tryGit(['rev-parse', '--verify', `refs/heads/${t.branch}`]);
    let head = parent;
    if (parent && git(['rev-parse', `${parent}^{tree}`]) === tree) {
      console.log(`${t.branch}: up to date`);
    } else {
      const commit = git([
        'commit-tree',
        tree,
        ...(parent ? ['-p', parent] : []),
        '-m',
        `Sync ${t.branch} from ${label}@${short}`,
      ]);
      head = commit;
      console.log(`${t.branch}: ${commit.slice(0, 7)} (from ${label}@${short})`);
    }
    if (head) git(['update-ref', `refs/heads/${t.branch}`, head]);
    if (push && head && head !== published) {
      git(['push', remote, `${head}:refs/heads/${t.branch}`], { stdio: 'inherit' });
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
