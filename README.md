# EventKit

EventKit runs a hands-on Flutter workshop from start to finish.

1. **Desktop app** (Electron, Windows / macOS / Linux). Attendees sign in with an emailed one-time code. A single click then installs and verifies the whole Flutter toolchain: Git, the Flutter SDK, Java 17, the Android SDK, Chrome, and VS Code with the Flutter extensions. Once the server accepts the laptop's readiness report, the app shows a rotating attendance QR code. During the offline phase it records connectivity in a tamper-evident log.
2. **Server** (Fastify + Prisma). It handles OTP auth, the signed toolchain manifest, the readiness gate, idempotent check-in, the phase-2 schedule, and log verification with compliance scoring. It also serves the admin site, the LAN mirror and desktop updates.
3. **Admin site** (React). It has these pages:
   - Live overview
   - Attendees and RSVP import
   - Door scanner (camera, USB/Bluetooth scanner, manual lookup)
   - Attendance export (CSV/XLSX)
   - Phase-2 control
   - Connectivity monitoring
   - Settings

```
 ┌──────────── attendee laptop ────────────┐  HTTPS   ┌──────────── server (Fastify) ────────────┐
 │ Electron main (sandboxed renderer)      │ ───────► │ /auth/*        OTP login                 │
 │  ├ setup engine: detect → download →    │          │ /api/manifest  Ed25519-signed manifest   │
 │  │   install → verify (resumable)       │          │ /api/readiness gate → per-attendee secret│
 │  ├ readiness report (HMAC device key)   │          │ /api/connectivity/{events,log}           │
 │  ├ QR = HMAC(secret, 60 s window)       │          │ /admin/*       cookie session + TOTP     │
 │  └ phase-2 monitor → hash-chained log   │          │ /mirror/*  /updates/*  admin SPA         │
 └─────────────────────────────────────────┘          │ Prisma: SQLite (dev) / Postgres (prod)   │
            ▲ shows QR                                └──────────────────────────────────────────┘
 ┌──────────┴─────────── door volunteer ───────────┐                ▲ SSE live updates
 │ admin site /scanner (camera or handheld scanner)│ ───────────────┘
 └─────────────────────────────────────────────────┘
```

Design notes are in [PLAN.md](PLAN.md). Every decision the spec left open is listed in [ASSUMPTIONS.md](ASSUMPTIONS.md).

## Quick start (development)

You need Node.js 22.12+ and pnpm 10 (`corepack enable` provides pnpm).

```sh
pnpm install
pnpm setup          # copies .env files, generates signing keys + OTP pepper, creates and seeds the SQLite DB
pnpm dev:simulate   # server :8080, admin site :5173, desktop app in simulate mode
```

- **Admin site.** Open http://localhost:5173. Sign in as `admin@example.org` / `change-me-please-now` (superadmin) or `volunteer@example.org` / `volunteer-dev-password` (scanner only).
- **Desktop app.** Sign in as `dev@example.com` or any seeded RSVP. Without SMTP configured, the OTP is printed in the server console.
- **Simulate mode.** Installs are faked with realistic timing, so you can run the whole flow on your own machine without touching your toolchain. The flow is: setup, then readiness, then the QR, then scanning in the admin, then phase 2. Optional flags:
  - `--simulate-fail=flutter:download,android:install` injects failures.
  - `--simulate-flaky` drops each download once mid-way, so you can watch it resume.
  - `--simulate-speed=4` runs the simulation faster.
- **Real mode.** `pnpm dev` (without `:simulate`) runs the real installers against your machine. It only works once the manifest is resolved (Admin → Settings → Manifest → Refresh), because placeholder artifacts are refused outside simulate mode.

| Command                                           | What it does                                      |
| ------------------------------------------------- | ------------------------------------------------- |
| `pnpm dev` / `pnpm dev:simulate`                  | Run server, admin and desktop together            |
| `pnpm dev -- --only=server,admin`                 | Run a subset                                      |
| `pnpm test`                                       | Unit and integration tests (Vitest)               |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`    | ESLint, `tsc`, Prettier                           |
| `pnpm build`                                      | Build shared, server, admin and desktop           |
| `pnpm keys:gen`                                   | New Ed25519 manifest key pair and OTP pepper      |
| `pnpm --filter @eventkit/server admin:create`     | Create or reset an admin user                     |
| `pnpm --filter @eventkit/server manifest:resolve` | Resolve upstream versions and hashes from the CLI |
| `pnpm --filter @eventkit/server mirror:sync`      | Download every manifest artifact into the mirror  |
| `pnpm --filter @eventkit/desktop dist:win`        | Build installers (`dist:mac`, `dist:linux`)       |

### Repository layout

```
packages/shared   Zod schemas, canonical JSON, Ed25519 manifest signing, rotating QR codes,
                  hash chain, compliance policy, Flutter release + doctor parsers
apps/server       Fastify API, Prisma schema + seed, manifest resolver, mirror, scripts
apps/admin        React admin site (Vite, Tailwind, TanStack Query)
apps/desktop      Electron main (setup engine, phase-2 monitor), preload, React renderer
```

## Configuration

### Server (`apps/server/.env`)

| Variable                                                                       | Notes                                                                                   |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                     | `production` enforces the settings below and disables placeholder artifacts             |
| `PUBLIC_BASE_URL`                                                              | Public origin, `https://` required in production                                        |
| `DATABASE_URL`                                                                 | `file:./dev.db` (SQLite) or `postgresql://...` (see [Deploying](#deploying-the-server)) |
| `DATA_DIR`                                                                     | Manifest cache, LAN mirror (`mirror/`) and desktop updates (`updates/`)                 |
| `OTP_PEPPER`                                                                   | 32+ random characters. OTPs are stored as HMAC(pepper, code), never in clear            |
| `MANIFEST_SIGNING_KEY`                                                         | Ed25519 private key (from `pnpm keys:gen`). Keep it secret                              |
| `MIN_APP_VERSION`                                                              | Older desktop apps are refused at readiness                                             |
| `EVENT_SLUG`, `EVENT_NAME`, `EVENT_TIMEZONE`                                   | Single event per deployment                                                             |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | OTP email. Test with Admin → Settings → Email                                           |
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`                                      | First superadmin, created by the seed                                                   |
| `TRUST_PROXY`                                                                  | `true` behind a reverse proxy, so rate limits see client IPs                            |
| `ADMIN_ORIGINS`                                                                | Extra origins allowed to call admin APIs (the Vite dev server)                          |
| `GITHUB_TOKEN`                                                                 | Optional. Raises the GitHub API limit for the manifest resolver                         |

### Desktop build (`apps/desktop/.env`, baked in at build time)

| Variable                     | Notes                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `MAIN_VITE_API_BASE_URL`     | The event server. Packaged builds refuse anything but `https://` (or localhost)      |
| `MAIN_VITE_MANIFEST_PUBKEYS` | Comma-separated Ed25519 public keys. Several keys allow rotation without a new build |

## Security model

- **Electron hardening.**
  - Renderer: `contextIsolation`, `sandbox` and no `nodeIntegration`, with a strict CSP injected at build time.
  - Navigation, new windows, webviews and permission requests are all denied.
  - Every IPC call checks that it comes from the app's own window and page and validates its payload with Zod.
  - Packaged binaries ship with Electron fuses that disable `RunAsNode`, `NODE_OPTIONS` and `--inspect`, and enforce asar integrity.
- **Transport.** All API traffic is HTTPS. The desktop app uses Chromium's network stack (`net.fetch`), so system proxies and certificates work.
- **Manifest integrity.**
  - The server signs the manifest with Ed25519 over canonical JSON. The app ships the public key(s) and rejects unsigned, tampered or expired manifests.
  - Every downloaded artifact is verified against its SHA-256 before it is used. This is why the LAN mirror may be plain HTTP.
- **Least privilege.**
  - Windows installs are per-user, with no UAC. That covers Git `/CURRENTUSER`, the user installer of VS Code and per-user Chrome.
  - Linux asks for `pkexec` once, for a constant script.
  - macOS needs admin only for Rosetta on Apple Silicon and the Xcode CLT prompt.
  - Child processes are spawned without a shell. Windows `.bat` shims go through `cmd.exe` with metacharacter-checked arguments.
- **Secrets.**
  - OTPs are hashed with a pepper, have a 10-minute expiry and allow 5 attempts. They are rate-limited per email.
  - Session tokens are stored as hashes. The desktop session, device key and QR secret are encrypted with the OS keychain (`safeStorage`).
  - Logs redact tokens, codes and keys. OTP codes are only printed to the console in development without SMTP.
- **Admin.**
  - argon2id passwords, optional TOTP 2FA, httpOnly SameSite=Strict cookies, and an Origin check on every mutation.
  - Roles are superadmin and volunteer, with volunteers limited to the scanner. Everything is written to an audit log.

### Client-side attestation cannot be fully trusted

The desktop app runs on hardware the attendee controls. The readiness report and the connectivity log are made **tamper-evident**: they are HMAC-signed with a per-device key, hash-chained, cross-checked against copies sent live, and checked against the server clock. They are **not tamper-proof**. A determined attendee could:

- extract the device key from their own keychain;
- run a modified app;
- or hide connectivity through another device or a VM.

What the system gives you:

- honest laptops produce strong evidence;
- casual cheating (quitting the app, editing or deleting log lines, changing the clock) is detected and flagged;
- every result is explainable from the raw log.

Treat "compliant" as "no evidence of a violation", not as proof. Use the monitoring view to decide whom to talk to, not to disqualify people automatically.

## Event-day runbook

### Two weeks before

1. Deploy the server ([below](#deploying-the-server)) with real SMTP. Send yourself a test mail from Admin → Settings → Email.
2. Settings → Toolchain:
   - pin the Flutter version you will teach;
   - set the minimum free disk space;
   - set the minimum app version.
   - Turn the NDK on together with the Gradle warm-up if attendees must build APKs offline.
3. Settings → Manifest: upload the starter project zip, then **Refresh manifest**. It must show "signed, resolved", not "placeholder".
4. Build and sign the installers with the release workflow. Copy the release files into `DATA_DIR/updates/`. Publish download links (for example on the event page).
5. **Run a real setup on a fresh VM or laptop for each OS** (Windows 11, macOS on Apple Silicon, Ubuntu LTS). It must reach "Ready". Simulate mode does not exercise the real installers.
6. Import the RSVP CSV (Attendees → Import). Any export with an email column works, plus optionally a name column or first/last name columns.
7. Create volunteer accounts (Settings → Admin users) and turn on 2FA for every superadmin.

### The day before

1. Optional LAN mirror. Run `pnpm --filter @eventkit/server mirror:sync`, then set **LAN mirror URL** to `http://<server-lan-ip>:8080/mirror`. Clients try the mirror first and fall back to upstream. Every file is still SHA-256-verified.
2. Phase 2 control: set the window, time zone, mode (strict or lenient), grace period and heartbeat. Attendee apps pick up the schedule every minute while online.
3. Check the door devices. Open `/scanner` on each phone or laptop and test the camera, the handheld scanner and manual lookup.

### At the door

- Attendees open EventKit → **Profile & QR** and show the code. It rotates every minute, so screenshots stop working.
- A scan shows ✓ checked in, ↺ already checked in (no double counting), ✗ not ready, or expired/invalid.
- A superadmin can do a manual check-in from the scanner's manual lookup. It requires a reason and is audit-logged. Volunteers can look people up but cannot check them in manually.

### Setup help desk

- Overview shows who is installing or needs repair. The attendee drawer shows their per-component progress and errors.
- On the laptop: Setup → "Show live log" and "Copy diagnostics". Setup resumes after network drops and app restarts, so clicking **Retry** is usually enough.
- Common fixes:
  - low disk: free space and retry;
  - corporate proxy: the app uses system proxy settings;
  - macOS: approve the Xcode Command Line Tools prompt;
  - Linux: enter the password in the single `pkexec` prompt.

### Offline phase (phase 2)

1. About 5 minutes before the start, apps do a final sync and tell attendees "safe to disconnect".
2. Watch **Monitoring**:
   - laptops still online after the grace period appear as violations within seconds;
   - laptops that quit the app show a monitoring gap once their log arrives.
3. Use **Start now** or **End now** to adjust the window live. Clients pick up the change within a minute.
4. After the phase, ask everyone to reconnect. Logs upload automatically. The status settles from "unverified" to its final value once a verified log covers the whole window.
5. Export: Monitoring → CSV/XLSX, and Attendance → CSV/XLSX (name, email, time, method, scanner).

### After the event

- Export attendance and monitoring, then archive the database (or `DATA_DIR` plus the SQLite file).
- Rotate the manifest key if it might have leaked. Print a new pair with `node scripts/gen-keys.mjs --print` and ship a build that trusts both public keys. Then switch the server to the new private key, and drop the old public key from later builds.

## LAN mirror

Venue Wi-Fi rarely survives 100 people downloading Android SDKs at once. The server can mirror every artifact:

```sh
pnpm --filter @eventkit/server mirror:sync   # downloads and verifies each artifact into DATA_DIR/mirror
```

Then set Admin → Settings → **LAN mirror URL** to `http://<lan-ip>:8080/mirror` (or point it at nginx serving the same directory). The manifest stays signed, and each file keeps its upstream SHA-256, so the mirror cannot substitute binaries. Plain HTTP on the LAN is fine. Clients try the mirror first and fall back to the upstream URL.

## Deploying the server

The server is a single Node process. Live updates (SSE) fan out in memory, so run one instance behind TLS.

```sh
pnpm install --frozen-lockfile
pnpm --filter @eventkit/server db:pg                         # writes prisma/schema.postgres.prisma
cd apps/server
export DATABASE_URL=postgresql://eventkit:***@db:5432/eventkit
npx prisma db push --schema prisma/schema.postgres.prisma    # creates tables
npx prisma generate --schema prisma/schema.postgres.prisma
cd ../..
pnpm --filter @eventkit/admin build && pnpm --filter @eventkit/server build
cd apps/server
NODE_ENV=production pnpm db:seed                             # first superadmin from SUPERADMIN_*, no demo data
NODE_ENV=production node dist/index.js                       # paths in .env are relative to apps/server
```

Put it behind a TLS proxy and set `TRUST_PROXY=true`. With Caddy, `event.example.org { reverse_proxy 127.0.0.1:8080 }` is all it needs; SSE works without buffering tweaks. SQLite is fine for a single event on one machine. Back up the `.db` file and `DATA_DIR`.

## Building installers and auto-update

```sh
pnpm --filter @eventkit/desktop dist:win     # NSIS one-click, per-user (no UAC)
pnpm --filter @eventkit/desktop dist:mac     # dmg + zip, arm64 and x64
pnpm --filter @eventkit/desktop dist:linux   # AppImage + deb
```

Output goes to `apps/desktop/release/`. Set `MAIN_VITE_API_BASE_URL` (https) and `MAIN_VITE_MANIFEST_PUBKEYS` first, in `apps/desktop/.env` or the environment.

**CI.**

- `.github/workflows/ci.yml` runs format, lint, typecheck, tests and build on Ubuntu, plus desktop tests on Windows and macOS.
- `.github/workflows/release.yml` builds all three platforms when a `v*` tag is pushed and attaches them to a draft GitHub release. The tag must match `apps/desktop/package.json`.
- Configure the repository variables `EVENTKIT_SERVER_URL` and `EVENTKIT_MANIFEST_PUBKEYS`, plus the signing secrets below.

**Auto-update** (electron-updater):

- The app checks `<server>/updates/` 30 s after start and then every 4 hours. It never checks during the offline phase.
- To publish an update, copy every file of a release, including `latest.yml`, `latest-mac.yml` and `latest-linux.yml`, into `DATA_DIR/updates/` on the server.
- Updates install on the next quit. Downloads are verified with the sha512 in the yml.
- The deb package updates through apt instead. AppImage, NSIS and the macOS zip self-update.

## Code signing and notarization

Unsigned builds work, but attendees will see scary warnings. Sign anything you hand out.

**Windows (SmartScreen).**

- Without Authenticode, SmartScreen shows "Windows protected your PC". Attendees must click _More info → Run anyway_.
- Sign with an OV or EV code-signing certificate. Set `WIN_CSC_LINK` (base64 `.pfx` or a path) and `WIN_CSC_KEY_PASSWORD`.
- EV certificates (or Azure Trusted Signing) build SmartScreen reputation immediately. OV certificates gain reputation over time and downloads.
- electron-updater verifies that each update is signed by the same publisher as the installed app.

**macOS (Gatekeeper).**

- Unsigned or unnotarized apps are blocked ("cannot be opened because the developer cannot be verified"). Attendees would have to right-click → Open, or allow the app in System Settings → Privacy & Security.
- Sign with a **Developer ID Application** certificate: `CSC_LINK` / `CSC_KEY_PASSWORD`, which the workflow maps from the `MAC_CSC_*` secrets.
- Notarize by setting `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID`. electron-builder then notarizes and staples automatically.
- The hardened runtime is on (`build/entitlements.mac.plist`). macOS auto-update requires a signed app.

**Linux.** No OS-level signing is needed. Publish `SHA256SUMS.txt` (the release workflow writes it) so attendees can verify downloads.

## Testing

- `pnpm test` runs about 170 tests:
  - shared: crypto, QR windows, hash chain, compliance policy, parsers;
  - server: auth, admin, manifest signing, readiness gate, idempotent scan, phase-2 tamper cases, using real SQLite;
  - desktop: resumable downloader, setup engine state machine, env and PATH persistence, Windows quoting, network probes, local log.
- `windows.test.ts` only runs on Windows. CI covers it.
- Use `pnpm dev:simulate` with `--simulate-fail` and `--simulate-flaky` for end-to-end UI flows.
- Before an event, do the fresh-VM runs from the runbook. They are the only test of the real installers against real upstreams.
