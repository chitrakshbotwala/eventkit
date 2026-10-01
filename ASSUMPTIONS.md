# Assumptions & Decisions

Decisions taken without asking. Each one is small and can be reversed.

## General

- **Volunteers** (role `volunteer`) can only use the scanner. They can look up attendees by name or email but cannot do manual check-ins. Only superadmins can, and every manual check-in needs a reason, which is audit-logged.
- **One event per deployment.** There is an `Event` table, but the server works on the single event named by `EVENT_SLUG`. For multi-tenant use, scope the queries by event id (the columns already exist).
- **Working names.** The product is called "EventKit" (`@eventkit/*` packages). Change `productName` and `appId` in `apps/desktop/electron-builder.yml` to rebrand it.
- **Pinned toolchain versions.** TypeScript 5.9, Vite 7, Vitest 3.2, Prisma 6, Fastify 5, Zod 4, React 19, React Router 7, Tailwind 4, Electron 44, electron-vite 5, and electron-builder 26. We picked these over newer majors because the typescript-eslint, electron-vite and Prisma 7 driver-adapter changes are compatible with them.
- **Deployment.** The server is one process. SSE fan-out happens in memory, so run a single instance behind TLS (for example Caddy). Scaling horizontally would need Postgres LISTEN/NOTIFY or Redis. That is out of scope.
- **Database.** Prisma cannot switch providers through env. `schema.prisma` targets SQLite. `pnpm --filter @eventkit/server db:pg` writes `schema.postgres.prisma` with the provider swapped. The schema avoids enums and native JSON types (JSON is stored as `String`), so it stays portable.

## Auth

- **Attendee sessions** use opaque 256-bit tokens. Only their SHA-256 hash is stored (the `Session` table was added). They expire after 30 days, and the desktop app keeps the token encrypted with `safeStorage`.
- **OTP.** 6 digits, stored as an HMAC-SHA256 with a server pepper, 10 minute expiry, 5 attempts. A new request invalidates the previous code. Limits are 3 requests per email per 10 minutes plus a 30 s cooldown. Per-IP limits are deliberately generous, because the whole venue sits behind one NAT IP.
- **Admins** log in with a cookie session (httpOnly, SameSite=Strict, Secure in prod) and an argon2id password hash (`@node-rs/argon2`, which ships prebuilt binaries and needs no node-gyp). TOTP is RFC 6238 (SHA-1, 6 digits, 30 s) so it works with any authenticator app. Mutating admin requests must send a matching `Origin`. The first superadmin comes from `SUPERADMIN_EMAIL`/`SUPERADMIN_PASSWORD` via the seed, or from `pnpm --filter @eventkit/server admin:create`.

## Device key, readiness and QR

- On OTP verify, the client sends a random `clientDeviceId`. The server returns a server-generated 256-bit **device key**, which stays stable per (attendee, device). The device key HMAC-signs readiness reports and every connectivity log entry.
- **Readiness report** = canonical JSON plus HMAC(deviceKey). The server re-checks it against the current manifest: every enabled required component is verified, versions meet the minimums, Flutter equals the pinned version if one is set, and the required doctor categories pass. Only then does it set `status=ready` and return the per-attendee **QR secret**. The secret is generated once per attendee and reused across that attendee's devices. A later failing report sets the attendee back to `not_ready`, and scans are then refused.
- **QR payload** is `EK1.<attendeeId>.<window>.<code>`, where `window = floor((now + serverOffset) / 60 s)` and `code` = 8-digit dynamic truncation of HMAC-SHA256(secret, window). The server accepts window ±1. If the window is further off but the HMAC is valid, the result is `expired`. Otherwise it is `invalid`. The window is included so the server can tell "expired" apart from "forged".
- **Android licence consent** is shown as a notice next to the single "Set up my laptop" button. Clicking the button counts as acceptance, so there are no extra prompts mid-setup. If the admin disables the Android component, the notice is hidden.

## Manifest & downloads

- The server **resolves** upstream metadata and stores the result in `Setting`. The admin triggers this with "Refresh manifest" or `pnpm manifest:resolve`. Sources:
  - Flutter release JSON (sha256 included)
  - Adoptium API (checksum included)
  - VS Code update API (sha256 included)
  - GitHub API for Git for Windows (asset `digest`)
  - Android `repository2-3.xml` and Chrome, which publish no SHA-256. The server downloads these once into the mirror cache and computes the hash.

  `GET /api/manifest` builds the manifest from the resolved data plus settings (pinned version, toggles, mirror) and signs it with Ed25519 over canonical JSON. When nothing is resolved yet and `MANIFEST_ALLOW_PLACEHOLDER=true` (the dev default), the server returns placeholder artifacts that only `--simulate` can "install".

- The server's cache directory is served at `/mirror/*`. Set `mirrorBaseUrl` to it (or to an nginx box synced with `pnpm mirror:sync`) to get a LAN mirror. The mirror **may be plain HTTP**, because every artifact is SHA-256-verified. API traffic stays HTTPS.
- Chrome's upstream URL is mutable, so its hash can go stale. Clients try the mirror first. On a hash mismatch from the official URL, the step fails with "ask organizers to refresh manifest" rather than installing an unverified binary.
- **Android versions** (platform, build-tools, optional NDK) come from Flutter's `FlutterExtension.kt` at the pinned or latest version. The admin can override them. Defaults are `platforms;android-36` and `build-tools;36.0.0`. The NDK is off by default. Without the NDK, the offline phase cannot build APKs for projects that need it, so the admin should enable the NDK together with the Gradle warm-up if APK builds matter offline.

## Platform strategy

- **Windows.** Flutter, Temurin (zip) and the Android SDK are extracted to the install root, so no admin rights are needed. Git uses `/CURRENTUSER` and VS Code uses the user installer, so neither needs admin. Chrome uses the `needsadmin=false` per-user installer. winget is used only for Git and VS Code, only when no mirror is set, and falls back to direct download if it fails. Temurin and Chrome through winget would force UAC.
- **Windows batch files** (`flutter.bat`, `code.cmd`, `sdkmanager.bat`) cannot be spawned without a shell since Node's CVE-2024-27980 fix. We run them through `cmd.exe /d /s /c` with an argument array. Every argument is validated to contain no cmd metacharacters, and install paths already contain no spaces or non-ASCII characters.
- **Windows PATH** is read raw (without expanding `%VARS%`) from `HKCU\Environment` and written back as `REG_EXPAND_SZ`. WM_SETTINGCHANGE is broadcast through .NET `SetEnvironmentVariable`. The PowerShell script is constant, and values are passed through environment variables.
- **Extraction** uses the OS tools, which are fast and preserve symlinks and modes: `%SystemRoot%\System32\tar.exe` on Windows, `ditto` on macOS, `tar` on Linux. `extract-zip` is the fallback. The admin's starter zip always goes through `extract-zip`, which guards against zip-slip.
- **Linux** uses a single `pkexec` call. It runs a constant script whose packages are passed as positional arguments, and it also installs the Chrome .deb/.rpm in the same call. Arch has no Chrome in its official repos, so it installs `chromium` and sets `CHROME_EXECUTABLE`.
- **fish shell** gets its environment from `~/.config/fish/conf.d/eventkit.fish` rather than an edit to `config.fish`.

## Phase 2

- The client log is one JSONL file per `logId`. A new `logId` starts on each schedule version or reinstall. Each entry has these fields:
  - `seq`, `wallTime`, `monoMs` (from `process.hrtime`), `bootId` (derived from boot time)
  - `type`, `data`, `prevHash`
  - `hash` = sha256 of the canonical entry
  - `hmac` = HMAC(deviceKey, hash)
- Event types are the spec's set plus `limited` (an interface is up but there is no internet), `suspend`/`resume` (powerMonitor) and `phase_start`/`phase_end`. When the wall clock jumps forward and the monotonic clock does not, and there is no suspend event, we record a `clock_anomaly`. Suspend time is reported as a gap, not as tampering.
- A probe counts as "internet reachable" if ANY HTTP response comes back from ANY probe endpoint, including captive-portal redirects, or if a TCP handshake to a public IP succeeds. Virtual adapters (WSL, Hyper-V, Docker, VirtualBox, VMware, loopback, link-local) do not count toward "interface up". VPN adapters (WARP, WireGuard, OpenVPN, Tailscale and similar) are ignored too. They only carry traffic when a physical link is up, and that link is what gets judged.
- **A LAN-only event server is not "internet".** If the server URL is a private or loopback host, reaching it does not count as online. This means a venue that hosts the server on its LAN can keep it reachable during phase 2. A public server URL does count as internet.
- **Gaps under 60 s are ignored.** Clients learn about "Start now" on their next schedule sync, which happens every minute, so a few seconds of no coverage at phase start (or around a restart) is not reported as a monitoring gap.
- **Online at grace end.** If a laptop is still online when the grace period ends, it writes an extra heartbeat at that moment. The violation then appears immediately instead of at the next regular heartbeat.
- **Ingest is serialized per device.** The realtime flush and the full-log upload can race, so they are serialized per device with an in-process lock (the server is a single instance, see Deployment).
- **Status priority:** tampered > violation > monitoring_gap > unverified > warning > compliant. A live violation is final even before the log is uploaded. "Compliant" requires a verified uploaded log that covers the whole window.
- **Auto-launch** uses `setLoginItemSettings` on Windows and macOS and an XDG autostart `.desktop` file on Linux. It is registered after login. During phase 2, closing the window hides the app to the tray.

## Packaging and updates

- **Installers.** Windows gets one NSIS one-click installer: per-user, no UAC, **x64 only**. Windows on Arm runs it, and the x64 toolchain it installs, under emulation, and a dual-arch installer would double the download. macOS gets a dmg plus a zip for each of arm64 and x64. Linux gets an AppImage and a deb.
- **Updates come from the event server**, not GitHub. The app points electron-updater at `<server>/updates/` at runtime, so the update feed is the same HTTPS origin the app already trusts. No public release hosting is needed, and organizers decide when an update goes live by copying files. The deb package does not self-update. Updates are never checked during phase 2.
- **Electron fuses** are flipped at package time: no `RunAsNode`, no `NODE_OPTIONS`, no `--inspect`, and asar integrity validation is on. Chromium's `--remote-debugging-port` cannot be disabled this way, which is one more reason client attestation is evidence rather than proof (see README).

## Not attempted

- Real code signing and notarization. The CI has the hooks, and the README documents the secrets.
- No live installer runs were done on the dev machine. Installers are exercised through `--simulate` and unit tests of the pure logic. Before the event, run a real fresh-VM test per OS (see the runbook).
