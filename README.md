# EventKit

EventKit runs a hands-on Flutter workshop from start to finish.

1. **Desktop app** (Electron, Windows / macOS / Linux). Attendees sign in with their Google account (it must match their RSVP email). A single click then installs and verifies the whole Flutter toolchain: Git, the Flutter SDK, Java 17, the Android SDK, Chrome, and VS Code with the Flutter extensions. Once the server accepts the laptop's readiness report, the app shows a rotating attendance QR code. During the offline phase it records connectivity in a tamper-evident log.
2. **Server** (Fastify + Prisma). It handles Google sign-in against the RSVP list, the signed toolchain manifest, the readiness gate, idempotent check-in, the phase-2 schedule, and log verification with compliance scoring. It also serves the admin site, the LAN mirror and desktop updates.
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
 │ Electron main (sandboxed renderer)      │ ───────► │ /auth/google/* Google sign-in (PKCE)     │
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

A plain-language walkthrough is in [HOW_IT_WORKS.md](HOW_IT_WORKS.md). Design notes are in [PLAN.md](PLAN.md). Every decision the spec left open is listed in [ASSUMPTIONS.md](ASSUMPTIONS.md).

## Quick start (development)

You need Node.js 22.12+ and pnpm 10 (`corepack enable` provides pnpm). With Nix, `nix-shell` provides both, plus everything Electron and Prisma need. On Linux, including NixOS, it is an FHS environment, so the binaries pnpm downloads run unpatched.

```sh
pnpm install
pnpm bootstrap      # copies .env files, generates the manifest signing keys, creates and seeds the SQLite DB
pnpm dev:simulate   # server :8080, admin site :5173, desktop app in simulate mode
```

- **Admin site.** Open http://localhost:5173. Sign in as `admin@example.org` / `change-me-please-now` (superadmin) or `volunteer@example.org` / `volunteer-dev-password` (scanner only).
- **Desktop app.** Click **Continue with Google**. Without `GOOGLE_CLIENT_ID`, the browser shows a development page instead of Google: pick `dev@example.com` or any seeded RSVP.
- **Simulate mode.** Installs are faked with realistic timing, so you can run the whole flow on your own machine without touching your toolchain. The flow is: setup, then readiness, then the QR, then scanning in the admin, then phase 2. Optional flags:
  - `--simulate-fail=flutter:download,android:install` injects failures.
  - `--simulate-flaky` drops each download once mid-way, so you can watch it resume.
  - `--simulate-speed=4` runs the simulation faster.
- **Real mode.** `pnpm dev` (without `:simulate`) runs the real installers against your machine. It only works once the manifest is resolved (Admin → Settings → Manifest → Refresh), because placeholder artifacts are refused outside simulate mode.

| Command                                           | What it does                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm dev` / `pnpm dev:simulate`                  | Run server, admin and desktop together                                                               |
| `pnpm dev -- --only=server,admin`                 | Run a subset                                                                                         |
| `pnpm test`                                       | Unit and integration tests (Vitest)                                                                  |
| `pnpm lint` / `pnpm typecheck` / `pnpm format`    | ESLint, `tsc`, Prettier                                                                              |
| `pnpm build`                                      | Build shared, server, admin and desktop                                                              |
| `pnpm bootstrap`                                  | First-time setup: .env files, keys, database, seed data (not `pnpm setup`, which is a pnpm built-in) |
| `pnpm keys:gen`                                   | New Ed25519 manifest key pair                                                                        |
| `pnpm --filter @eventkit/server admin:create`     | Create or reset an admin user                                                                        |
| `pnpm --filter @eventkit/server manifest:resolve` | Resolve upstream versions and hashes from the CLI                                                    |
| `pnpm --filter @eventkit/server mirror:sync`      | Download every manifest artifact into the mirror                                                     |
| `pnpm --filter @eventkit/desktop dist:win`        | Build installers (`dist:mac`, `dist:linux`)                                                          |
| `node scripts/split-branches.mjs`                 | Rebuild the `server` and `desktop` branches                                                          |

### Repository layout

```
packages/shared   Zod schemas, canonical JSON, Ed25519 manifest signing, rotating QR codes,
                  hash chain, compliance policy, Flutter release + doctor parsers
apps/server       Fastify API, Prisma schema + seed, manifest resolver, mirror, scripts
apps/admin        React admin site (Vite, Tailwind, TanStack Query)
apps/desktop      Electron main (setup engine, phase-2 monitor), preload, React renderer
deploy            VPS files: Caddyfile, systemd unit, production .env template, update and backup scripts
```

### Branches

| Branch    | Contents                                                  | Deployed as                                        |
| --------- | --------------------------------------------------------- | -------------------------------------------------- |
| `main`    | Everything. All development happens here and CI runs here | (source of truth)                                  |
| `server`  | `packages/shared`, `apps/server`, `apps/admin`, `deploy/` | Cloned on the VPS, updated with `deploy/update.sh` |
| `desktop` | `packages/shared`, `apps/desktop`, the release workflow   | Releases are built from `main` (see below)         |

`server` and `desktop` are generated from `main` by `scripts/split-branches.mjs`. The `Sync deploy branches` workflow runs it after CI passes on `main`. Each sync adds a commit on top, with no force pushes, so `git pull` keeps working on the VPS. Never commit to those branches directly.

## Configuration

### Server (`apps/server/.env`)

| Variable                                     | Notes                                                                                                                                                                                          |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                   | `production` enforces the settings below and disables placeholder artifacts                                                                                                                    |
| `PUBLIC_BASE_URL`                            | The server's public address, e.g. `https://event.example.org`: your domain, not the VPS IP. `https://` required in production. See [Choosing the server address](#choosing-the-server-address) |
| `DATABASE_URL`                               | `file:./dev.db` (SQLite) or `postgresql://...` (see [Deploying](#deploying-the-server-vps))                                                                                                    |
| `DATA_DIR`                                   | Manifest cache, LAN mirror (`mirror/`) and desktop updates (`updates/`)                                                                                                                        |
| `MANIFEST_SIGNING_KEY`                       | Ed25519 private key (from `pnpm keys:gen`). Keep it secret                                                                                                                                     |
| `MIN_APP_VERSION`                            | Older desktop apps are refused at readiness                                                                                                                                                    |
| `EVENT_SLUG`, `EVENT_NAME`, `EVENT_TIMEZONE` | Single event per deployment                                                                                                                                                                    |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`   | Google OAuth "Web application" client for attendee sign-in. Required in production. See [Google sign-in setup](#google-sign-in-setup)                                                          |
| `CONTACT_HINT`                               | Shown when a Google account is not on the RSVP list                                                                                                                                            |
| `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD`    | First superadmin, created by the seed                                                                                                                                                          |
| `TRUST_PROXY`                                | `true` behind a reverse proxy, so rate limits see client IPs                                                                                                                                   |
| `ADMIN_ORIGINS`                              | Extra origins allowed to call admin APIs (the Vite dev server)                                                                                                                                 |
| `GITHUB_TOKEN`                               | Optional. Raises the GitHub API limit for the manifest resolver                                                                                                                                |

### Desktop build (`apps/desktop/.env`, baked in at build time)

| Variable                     | Notes                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `MAIN_VITE_API_BASE_URL`     | The event server. Packaged builds refuse anything but `https://` (or localhost)      |
| `MAIN_VITE_MANIFEST_PUBKEYS` | Comma-separated Ed25519 public keys. Several keys allow rotation without a new build |
| `MAIN_VITE_UPDATE_REPO`      | `owner/repo` whose GitHub Releases feed auto-update. Set by the release workflow     |
| `MAIN_VITE_MAC_SIGNED`       | `1` for Developer ID-signed Mac builds; macOS auto-update is off otherwise           |

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
- **Attendee sign-in** follows OAuth 2.0 for native apps (RFC 8252):
  - The app opens the system browser, never an embedded webview. The Google client secret stays on the server.
  - Google's verified email is matched against the RSVP list.
  - The server hands the app a one-time code over a `127.0.0.1` loopback redirect. The code lives for 2 minutes, works once, and is bound to a PKCE verifier that never leaves the app, so an intercepted code is useless.
  - No email is ever sent.
- **Secrets.**
  - Session tokens and sign-in codes are stored only as hashes.
  - The desktop session, device key and QR secret are encrypted with the OS keychain (`safeStorage`): DPAPI on Windows, Keychain on macOS, and on Linux the Secret Service (gnome-keyring, KeePassXC) or KWallet. The app asks for the Secret Service explicitly when one is running on a window manager Chromium doesn't recognise, such as Hyprland (Omarchy), sway or i3. A Linux session with no keyring service at all still signs in: secrets are then encrypted with AES-256-GCM under a random key in `secret.key`, and both files are readable only by their owner (0600). The app log says which applies.
  - Logs redact tokens, codes and keys.
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

Attendees install and set up EventKit **at home, before the event**, and arrive with a laptop that already shows "Ready". Nothing is downloaded at the venue: the QR code, the starter project, the pub and Gradle caches and the offline-phase monitor all work without internet.

### Three to four weeks before

1. Deploy the server ([below](#deploying-the-server-vps)) and set up [Google sign-in](#google-sign-in-setup). Check Admin → Settings → Attendee sign-in: it should say "Google".
2. Settings → Toolchain:
   - pin the Flutter version you will teach;
   - set the minimum free disk space;
   - set the minimum app version;
   - keep **Gradle warm-up** on (the default) if attendees will build Android APKs. It fetches Gradle, the Android build dependencies and the NDK at home, so APK builds at the venue need no internet.
3. Settings → Manifest: upload the starter project zip, then **Refresh manifest**. It must show "signed, resolved", not "placeholder".
4. Publish the desktop app: Actions → **Release desktop app** → Run workflow with a version (see [Releasing the desktop app](#releasing-the-desktop-app)). Put `https://github.com/<owner>/<repo>/releases/latest` on the event page.
5. **Run a real setup on a fresh VM or laptop for each OS** (Windows 11, macOS on Apple Silicon, Ubuntu LTS, and any other Linux your attendees use), on a normal home connection. It must reach "Ready". Note how long it takes and how much it downloads (several GB), and put both in the attendee email. Simulate mode does not exercise the real installers.
6. Import the RSVP CSV (Attendees → Import). Any export with an email column works, plus optionally a name column or first/last name columns.
7. Create volunteer accounts (Settings → Admin users) and turn on 2FA for every superadmin.

### Two weeks before: attendees set up at home

1. Email attendees the download links, the "Ready by" date (for example two days before the event), the expected time and download size, and: "Sign in with the Google account of the email you RSVP'd with."
2. **Freeze the toolchain.** Don't change the pinned Flutter version, components, Android packages or the starter project after attendees start setting up. The app re-checks every laptop against the current settings, so a change turns "Ready" laptops "not ready", and fixing that needs downloads. Publish any desktop app update **before** this point too. An update published later is downloaded wherever the laptop is, including the venue.
3. Support people remotely. Overview shows who is still installing or needs repair, and the attendee drawer shows per-component progress and errors.
4. A few days before the "Ready by" date, filter Attendees by status and remind everyone who isn't **Ready**.

### The day before

1. Phase 2 control: set the window, time zone, mode (strict or lenient), grace period and heartbeat. Attendee apps pick up the schedule every minute while online.
2. Check the door devices. Open `/scanner` on each phone or laptop and test the camera, the handheld scanner and manual lookup. Door devices need to reach the server, so give them mobile data if the venue Wi-Fi is unreliable.

### At the door

- Attendees open EventKit → **Profile & QR** and show the code. The code is computed on the laptop, so it works without internet. It rotates every minute, so screenshots stop working.
- A scan shows ✓ checked in, ↺ already checked in (no double counting), ✗ not ready, or expired/invalid.
- **Not ready** means setup wasn't finished at home, and it can't be finished at the venue. A superadmin can still check the person in manually from the scanner's manual lookup, with a reason that goes into the audit log. Volunteers can look people up but cannot check them in manually.

### Setup help (before the event)

- "Not on the RSVP list" at sign-in means the attendee's Google email differs from their RSVP email. Edit their email in Attendees to the Google one, then have them click **Continue with Google** again.
- Ask the attendee for Setup → "Copy diagnostics" (and "Show live log"). Setup resumes after network drops and app restarts, so **Retry** is usually enough.
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
4. After the phase, ask everyone to reconnect. Logs upload automatically. The status settles from "unverified" to its final value once a verified log covers the whole window. Laptops that only get online after leaving the venue upload from wherever they are.
5. Export: Monitoring → CSV/XLSX, and Attendance → CSV/XLSX (name, email, time, method, scanner).

### After the event

- Export attendance and monitoring, then archive the database (`deploy/backup.sh`).
- Rotate the manifest key if it might have leaked. Print a new pair with `node scripts/gen-keys.mjs --print` and ship a build that trusts both public keys. Then switch the server to the new private key, and drop the old public key from later builds.

## LAN mirror (optional, not used for home setup)

Only useful if you ever run an in-person setup session, where many laptops would download the toolchain over one venue connection. `pnpm --filter @eventkit/server mirror:sync` copies every manifest artifact into `DATA_DIR/mirror`, which the server serves at `/mirror/`. Set its URL under Admin → Settings → **LAN mirror URL**. The manifest stays signed and every file keeps its upstream SHA-256, so the mirror cannot substitute binaries. Leave the setting empty when attendees set up at home.

## Choosing the server address

`PUBLIC_BASE_URL` is the HTTPS address of your server: a **hostname you control** that points at the VPS, such as `https://event.example.org`. It is not the VPS's IP address, because:

- Google sign-in only accepts redirect URIs on a real domain (public top-level domain, listed under Authorized domains), never a bare IP.
- Caddy gets the HTTPS certificate for that hostname automatically.
- The address is baked into the desktop installers, so a hostname lets you move to another VPS later by changing DNS only.

To get one, buy a domain (any registrar, roughly $10 a year) or use a subdomain of one you or your community already have. Then add an **A record** pointing at the VPS's public IP (shown in your VPS provider's dashboard, or run `curl -4 ifconfig.me` on the VPS). Check it with `nslookup event.example.org` before starting Caddy.

Use exactly the same value, with no trailing slash, everywhere:

| Where                         | Value                                                                   |
| ----------------------------- | ----------------------------------------------------------------------- |
| `apps/server/.env` on the VPS | `PUBLIC_BASE_URL=https://event.example.org`                             |
| `deploy/Caddyfile`            | `event.example.org {`                                                   |
| GitHub repository variable    | `EVENTKIT_SERVER_URL=https://event.example.org` (baked into installers) |
| Google OAuth client           | redirect URI `https://event.example.org/auth/google/callback`           |

Pick it before building installers: changing it later means rebuilding them and every attendee reinstalling.

## Deploying the server (VPS)

A small VPS is enough: 1 vCPU, 1–2 GB RAM, Ubuntu 24.04. Allow some bandwidth for the installer downloads it hosts (about 100 MB per attendee); the toolchain itself comes from the upstream CDNs, not the VPS. The server is one Node process behind Caddy, which handles HTTPS automatically. It uses SQLite on local disk. Commands are for Ubuntu and run as root unless noted.

1. **DNS.** Point an A (and AAAA, if the VPS has IPv6) record for your chosen hostname, for example `event.example.org`, at the VPS's IP. See [Choosing the server address](#choosing-the-server-address).
2. **Packages.**
   ```sh
   curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
   apt-get install -y nodejs git sqlite3 debian-keyring debian-archive-keyring apt-transport-https
   curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
   apt-get update && apt-get install -y caddy
   corepack enable
   ```
3. **User and code.**
   ```sh
   useradd --system --create-home --home-dir /opt/eventkit --shell /bin/bash eventkit
   install -d -o eventkit -g eventkit /var/lib/eventkit /var/lib/eventkit/data
   sudo -u eventkit git clone -b server https://github.com/chitrakshbotwala/eventkit /opt/eventkit
   ```
4. **Configure.** As `eventkit`, copy `deploy/server.env.example` to `apps/server/.env`, run `chmod 600`, and fill it in:
   - `PUBLIC_BASE_URL`;
   - `MANIFEST_SIGNING_KEY` (from `node scripts/gen-keys.mjs --print` on any machine);
   - `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`;
   - `SUPERADMIN_EMAIL` and `SUPERADMIN_PASSWORD`.
5. **Build and initialise** (as `eventkit`, in `/opt/eventkit`):
   ```sh
   pnpm install --frozen-lockfile
   pnpm --filter @eventkit/admin build && pnpm --filter @eventkit/server build
   pnpm --filter @eventkit/server exec prisma db push      # creates the SQLite database
   pnpm --filter @eventkit/server db:seed                  # first superadmin, no demo data in production
   ```
6. **Run.**
   ```sh
   cp /opt/eventkit/deploy/eventkit.service /etc/systemd/system/
   systemctl daemon-reload && systemctl enable --now eventkit
   cp /opt/eventkit/deploy/Caddyfile /etc/caddy/Caddyfile   # set your hostname in it first
   systemctl reload caddy
   ```
   Open `https://event.example.org`, sign in as the superadmin and turn on 2FA.
7. **Updates.** Run `/opt/eventkit/deploy/update.sh` as `eventkit`, then `systemctl restart eventkit`.
8. **Backups.** `deploy/backup.sh` makes a consistent SQLite copy plus `DATA_DIR`. Schedule it hourly from cron and copy the backups off the machine.

Postgres is optional, for example when you want a managed database. Run `pnpm --filter @eventkit/server db:pg`, set `DATABASE_URL=postgresql://...`, and use `--schema prisma/schema.postgres.prisma` with `prisma db push` and `prisma generate`. Live updates (SSE) and a few safeguards live in memory, so run exactly one server process.

## Google sign-in setup

1. Go to [Google Cloud console](https://console.cloud.google.com/) and create a project, for example "EventKit".
2. **OAuth consent screen** (Google Auth Platform → Branding / Audience):
   - Set the app name and support email. User type: **External**.
   - **Authorized domains:** add your registered domain, e.g. `example.org` for `event.example.org`. Google only accepts redirect URIs on authorized domains.
   - Scopes are only `openid`, `email` and `profile`. These are non-sensitive, so Google does not need to review the app.
   - **Publish the app** ("In production"). While it is in "Testing", only the test users you list can sign in.
3. **Credentials** → Create OAuth client ID → **Web application**:
   - Authorized redirect URI: `https://event.example.org/auth/google/callback`. Admin → Settings → Attendee sign-in shows the exact value.
   - Authorized JavaScript origin: `https://event.example.org`.
4. Put the client ID and secret in the server `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`, then restart the server.

For local development you can add `http://localhost:8080/auth/google/callback` as a second redirect URI on the same client. Or leave `GOOGLE_CLIENT_ID` empty to use the built-in development page; it is refused in production.

## Releasing the desktop app

Attendees download EventKit from this repository's GitHub Releases. Give them `https://github.com/<owner>/<repo>/releases/latest`: it always shows the newest release, with a download table per operating system and install instructions.

**To release:** GitHub → Actions → **Release desktop app** → **Run workflow** (branch `main`). Leave the version empty to release the version in `apps/desktop/package.json`, or enter a new one such as `0.2.0`. The workflow:

1. sets `apps/desktop/package.json` to the new version on `main`, if you entered one;
2. builds every installer, with the server URL and manifest key from the repository variables `EVENTKIT_SERVER_URL` and `EVENTKIT_MANIFEST_PUBKEYS` built in;
3. installs and launches each one (see launch tests below). Any failure stops the release, and nothing is tagged;
4. publishes the release, tagged `v<version>`, with the download notes from `.github/release-notes.md` and `SHA256SUMS.txt`.

A version can be released once. To ship a fix, run it again with the next version (`0.1.1`).

Other ways to run it:

- **Tick "Test build only":** everything is built and launch-tested and the installers are attached to the run as artifacts, but nothing is published.
- **Push a tag** `vX.Y.Z` that matches `apps/desktop/package.json`: releases that commit.
- **A version with a suffix**, such as `0.3.0-rc.1`: a pre-release. It is not marked "Latest" and installed apps don't update to it, so use it to try a build before attendees get it.

| File                             | For                                                 | Updates itself              |
| -------------------------------- | --------------------------------------------------- | --------------------------- |
| `EventKit-Setup-<v>-x64.exe`     | Windows 10 and 11 (Windows on Arm runs it emulated) | yes                         |
| `EventKit-<v>-arm64.dmg`         | Macs with Apple silicon                             | only if Developer ID signed |
| `EventKit-<v>-x64.dmg`           | Intel Macs                                          | only if Developer ID signed |
| `EventKit-<v>-amd64.deb`         | Debian, Ubuntu, Mint, Pop!\_OS                      | no: install the new version |
| `EventKit-<v>-x86_64.rpm`        | Fedora, RHEL, openSUSE                              | no: install the new version |
| `EventKit-<v>-x86_64.pkg.tar.xz` | Arch, Manjaro, EndeavourOS (`pacman -U`)            | no: install the new version |
| `EventKit-<v>-x86_64.AppImage`   | any other Linux                                     | yes                         |

The `.zip`, `.blockmap` and `latest*.yml` files in a release are for auto-update.

**Wayland and X11.** One Linux build runs on both. Electron uses Wayland natively when the session provides it, and X11 (or XWayland) otherwise. The window is tied to its desktop entry through the app id `eventkit` (`desktopName` in `apps/desktop/package.json`, `StartupWMClass` in the package), so docks show the right icon and name on both. On GNOME the tray icon needs the AppIndicator extension. Without it, launching EventKit again brings the window back.

**AppImage needs FUSE 2** (`libfuse2`, or `fuse2` on Arch), which some distros no longer install by default. If it says "AppImages require FUSE", install that or use the distro's package. **On Ubuntu 24.04 and later**, Ubuntu also blocks the unprivileged user namespaces that Chromium's sandbox uses, so the AppImage fails to start there. The `.deb` installs the sandbox helper properly, so tell Ubuntu users to use the `.deb`.

**Launch tests.** With `EVENTKIT_SMOKE_TEST=<file>`, a packaged build opens its window on a throwaway profile, makes one IPC round trip from the page, writes the result to the file and quits. `scripts/smoke-test.sh` wraps this. The release workflow runs it on:

- the Windows exe, after a silent install;
- the app inside the arm64 dmg;
- the AppImage, under Xvfb (X11) and under headless Weston (Wayland);
- the `.deb` on Ubuntu 24.04 and Debian 12, the `.rpm` on Fedora and the pacman package on Arch. Each is installed with the distro's package manager on a minimal image, which also checks that the declared dependencies are enough to run Electron.

**Auto-update** (electron-updater):

- Installed apps check this repository's releases 30 s after start and then every 4 hours, never during the offline phase. Updates download in the background, are verified against the sha512 in `latest*.yml`, and install on the next quit.
- Publishing a release therefore updates every attendee's app. Publish the final version **before** attendees start setting up (see the runbook).
- macOS installs only updates signed with the same Developer ID, so unsigned Mac builds don't auto-update. The `.deb`, `.rpm` and pacman packages update when the attendee installs the new version.
- A build made outside the release workflow (without `MAIN_VITE_UPDATE_REPO`) checks `<server>/updates/` instead. Copy a release's files, including `latest*.yml`, into `DATA_DIR/updates/` to serve them there.

**Local builds:**

```sh
pnpm --filter @eventkit/desktop dist:win     # NSIS one-click, per-user (no UAC)
pnpm --filter @eventkit/desktop dist:mac     # dmg + zip, arm64 and x64
pnpm --filter @eventkit/desktop dist:linux   # AppImage, deb, rpm, pacman (needs rpm and bsdtar)
```

Output goes to `apps/desktop/release/`. Set `MAIN_VITE_API_BASE_URL` (https) and `MAIN_VITE_MANIFEST_PUBKEYS` first, in `apps/desktop/.env` or the environment.

**CI.** `.github/workflows/ci.yml` runs format, lint, typecheck, tests and build on Ubuntu, plus desktop tests on Windows and macOS, on every push to `main` and every pull request.

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

- `pnpm test` runs about 180 tests:
  - shared: crypto, QR windows, hash chain, compliance policy, parsers;
  - server: Google sign-in (PKCE, replay, expiry, RSVP matching, ID-token checks), admin, manifest signing, readiness gate, idempotent scan, phase-2 tamper cases, using real SQLite;
  - desktop: OAuth loopback listener, resumable downloader, setup engine state machine, env and PATH persistence, Windows quoting, network probes, local log.
- `windows.test.ts` only runs on Windows. CI covers it.
- Use `pnpm dev:simulate` with `--simulate-fail` and `--simulate-flaky` for end-to-end UI flows.
- Before an event, do the fresh-VM runs from the runbook. They are the only test of the real installers against real upstreams.
