# How EventKit works

This is a plain-language tour of what happens, and why, from an attendee downloading the app to the organizers exporting the results. For setup commands see the [README](README.md). For every design decision see [ASSUMPTIONS.md](ASSUMPTIONS.md).

## The three parts

| Part            | Who uses it                    | Where it runs                      | Branch    |
| --------------- | ------------------------------ | ---------------------------------- | --------- |
| **Desktop app** | Attendees                      | Their own laptop (Win/macOS/Linux) | `desktop` |
| **Server**      | Everything talks to it         | Your VPS, behind HTTPS             | `server`  |
| **Admin site**  | Organizers and door volunteers | Served by the server, in a browser | `server`  |

The admin site is a web page served by the server itself, so there are only two things to deploy: the server (on the VPS) and the installers (built by GitHub Actions and downloaded by attendees). Both come out of one codebase, `main`, which also holds the `packages/shared` code they both use. That shared code covers the data formats, the cryptography and the rules.

```
          attendee laptop                                     VPS
 ┌──────────────────────────────┐   HTTPS (only)   ┌─────────────────────────────┐
 │ EventKit desktop app         │ ───────────────► │ EventKit server             │
 │  • sign in with Google       │                  │  • RSVP list, sessions      │
 │  • one-click toolchain setup │ ◄─────────────── │  • signed install manifest  │
 │  • attendance QR             │                  │  • check-ins                │
 │  • offline-phase monitor     │                  │  • offline-phase verdicts   │
 └──────────────────────────────┘                  │  • admin site + live feed   │
                                                   └──────────────▲──────────────┘
                     organizers / door volunteers (browser) ──────┘
```

## An attendee's day

1. **Download and install EventKit.** It's a one-click installer and needs no admin password on Windows.
2. **Continue with Google.** The browser opens and the attendee picks their Google account. If that email is on the RSVP list, they're in.
3. **Set up my laptop.** One button. The app installs Git, the Flutter SDK, Java 17, the Android SDK, Chrome, VS Code with the Flutter extensions and Flutter DevTools. It also pre-downloads a starter project so it builds offline. The attendee can watch a progress bar or walk away.
4. **Ready.** Once everything is verified, the app shows a QR code that changes every minute.
5. **At the door** a volunteer scans the QR. ✓ Checked in.
6. **Offline phase.** At a set time the attendee disconnects from the internet and builds with what's installed. EventKit records whether the laptop really stayed offline.
7. **Afterwards** they reconnect, and the app uploads its record by itself.

## Behind each step

### 1. Signing in (no email, no codes)

The app never sees the attendee's Google password, and the server never needs to send an email. This is the standard OAuth flow for desktop apps (RFC 8252), the same one the `gcloud` and `gh` command-line tools use.

```
 Desktop app                     Browser                     EventKit server               Google
     │ make secret "verifier" V      │                             │                          │
     │ start listener 127.0.0.1:P    │                             │                          │
     │ open /auth/google/start?port=P&challenge=hash(V) ──────────►│ remember P + hash(V)     │
     │                               │◄── redirect to Google ──────│                          │
     │                               │──── attendee picks account ────────────────────────────►│
     │                               │◄─────────────────────────────────── redirect + code ───│
     │                               │──── /auth/google/callback ─►│ swap code (with secret)  │
     │                               │                             │──────────────────────────►│
     │                               │                             │◄── verified email ───────│
     │                               │                             │ email on RSVP list?      │
     │◄── redirect 127.0.0.1:P/callback?code=ONE-TIME ─────────────│                          │
     │ POST /auth/google/exchange {ONE-TIME, V} ──────────────────►│ hash(V) matches? → session
     │◄──────────────────────────────── session token + device key │                          │
```

Why each piece is there:

- **System browser, not a window inside the app.** Attendees type their Google password only on Google's real page, with their saved logins and 2-step verification.
- **Client secret on the server only.** The installer contains nothing secret about the Google project.
- **Loopback listener plus PKCE.** The one-time code goes to `127.0.0.1` on the attendee's own laptop. It is useless without the verifier `V`, which never leaves the app. The code also expires after 2 minutes and works only once.
- **Verified email to RSVP list.** This is the only identity check. If someone RSVP'd with a different address, the app says so and the help desk edits their RSVP email.

After sign-in, the app stores the session token and a per-laptop **device key** in the OS keychain (`safeStorage`). The device key later signs the readiness report and the offline log.

### 2. One-click setup

**The manifest.** The server publishes a list of what to install for each OS and CPU: exact versions, download URLs and a SHA-256 fingerprint for every file. Organizers choose the versions in the admin settings, for example pinning Flutter 3.35.4. The server fills in the upstream URLs and hashes, then **signs the list with an Ed25519 key**. The app has the public key built in and refuses any list that is unsigned, altered or expired. Even someone controlling the network, or the venue mirror, cannot make laptops install something else.

**The setup engine** in the desktop app works through components in order:

```
system check → (Linux packages) → Git → Flutter → Java → Android SDK → Chrome → VS Code → DevTools → warm-up → final verification
```

For each component it:

1. **Detects** whether a good version is already installed, and skips it if so.
2. **Downloads**, two files at a time. Downloads resume after Wi-Fi drops because they use HTTP Range requests and the progress is saved. If the organizers set up a **LAN mirror**, it uses that first. Every file is checked against its SHA-256 before use.
3. **Installs** without admin rights wherever possible. Windows installs are per-user. Linux asks for the password once. macOS needs it only for Rosetta and Xcode's command-line tools.
4. **Updates PATH** and environment variables, so `flutter` works in new terminals.
5. **Verifies**: runs `flutter doctor -v`, then builds the starter project offline (`pub get --offline`), so the offline phase won't surprise anyone.

Progress streams to the server, so the help desk can see who is stuck and why. State is saved after every step, so closing the app or rebooting resumes where it left off.

### 3. Ready, and the attendance QR

When setup finishes, the app sends a **readiness report** listing every component, its version and the doctor results, signed with the device key. The server does not just believe it. It re-checks the report against the current manifest: required components present, versions right, doctor categories passing. Only then does it mark the attendee **ready** and give the app a secret for their QR code.

**The QR** is `EK1.<attendee>.<minute>.<8-digit code>`, where the code is a keyed hash (HMAC) of the secret and the current minute.

- It changes every minute, so a screenshot sent to a friend stops working.
- The server accepts the current minute plus or minus one, to allow for clock drift.
- It works offline: the laptop computes it locally.
- The QR cannot appear before the server has accepted readiness, because the app doesn't have the secret yet.

**At the door** the scanner page (camera, USB/Bluetooth scanner or manual lookup) sends the code to the server, which answers one of:

- ✓ **checked in**;
- ↺ **already checked in**: no double counting, because there is one attendance row per person, enforced by the database;
- ✗ **not ready**;
- **expired**;
- **invalid**.

A superadmin can check someone in manually from the scanner page, with a written reason that goes into the audit log.

### 4. The offline phase

Organizers set the window in **Phase 2 control**: start, end, time zone, grace period (default 2 minutes) and mode. They can also hit **Start now** or **End now**. Apps fetch the schedule every minute while online, and about 5 minutes before the start they do a final sync and tell the attendee **"safe to disconnect"**.

During the phase the app:

- **watches network interfaces** every second (Wi-Fi, Ethernet, phone tethering). Virtual adapters such as WSL, Docker and VPNs are ignored.
- **probes for internet** every 5 seconds, and immediately when an interface changes. It counts as online if any of these work:
  - Google's connectivity check (including captive-portal redirects);
  - Cloudflare;
  - the event server, when it is a public address;
  - a raw TCP connection to 1.1.1.1 or 8.8.8.8.
- **writes everything to a local log**, one line per event:
  - online, offline, or limited (interface up but no internet);
  - heartbeats every minute;
  - app start and stop, sleep and wake;
  - clock jumps.

**The log is tamper-evident.** Each line contains the fingerprint (SHA-256) of the previous line, a hash chain, and is signed with the device key. Deleting, editing or reordering any line breaks the chain. The log also records a monotonic clock that can't be changed, so moving the system clock shows up as a "clock anomaly".

**Two copies reach the server:**

- **Live.** Whenever the laptop is online, new lines are sent right away. During the phase, being online is itself the violation, so the admin sees it within seconds.
- **Full log.** Once the laptop is back online after the phase, the whole log is uploaded. The server verifies the chain end to end and compares it with the live copies. A line that was sent live but is missing or different in the upload counts as tampering.

**The verdict**, computed by the server and shown in Monitoring, uses this priority:

| Status             | Meaning                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| **tampered**       | Broken chain or signature, or the log disagrees with what was sent live   |
| **violation**      | Internet reachable at any moment between grace end and phase end          |
| **monitoring gap** | App not running (quit, crashed, laptop asleep) for a minute or more       |
| **unverified**     | No complete, verified log for the whole window yet (e.g. not reconnected) |
| **warning**        | Strict mode: an interface was up without internet; or clock anomalies     |
| **compliant**      | Verified log covers the whole window and shows no internet                |

Gaps under 60 seconds are ignored. Without that, every laptop would show a gap at the start, because clients learn about **Start now** only on their next once-a-minute sync. Both Monitoring and Attendance export to CSV and XLSX.

### 5. Organizer tools (admin site)

| Page                | What it's for                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| **Overview**        | Live counters: RSVPs, signed in, installing, ready, checked in, phase-2 results                       |
| **Attendees**       | RSVP import (CSV from Luma, Meetup, Google Forms…), status, per-laptop setup progress, edit emails    |
| **Scanner**         | Door check-in: camera, handheld scanner, manual lookup                                                |
| **Attendance**      | Who checked in, when, how and by whom, with CSV/XLSX export                                           |
| **Phase 2 control** | Schedule, mode, grace, Start now / End now                                                            |
| **Monitoring**      | Per-attendee verdict, live feed, export                                                               |
| **Settings**        | Versions, components, LAN mirror, starter project, Google sign-in status, admin users, 2FA, audit log |

Admins sign in with a password and optional 2FA (any authenticator app). There are two roles:

- **superadmin:** everything.
- **volunteer:** scanner only.

Everything that changes state is written to the audit log.

## Where things run and how they update

```
 main ──(CI passes)──► scripts/split-branches.mjs ──► server  ──git pull──► VPS (systemd + Caddy)
                                                  └──► desktop ──tag v*──► GitHub Actions ──► signed installers
                                                                                   │
                                     copy release files to <server>/updates/ ◄──────┘
                                     apps auto-update from there (never during the offline phase)
```

- **Server.** Clone the `server` branch on the VPS. Run `deploy/update.sh`, then restart the service. Caddy provides the HTTPS certificate. SQLite stores everything in `/var/lib/eventkit`, and `deploy/backup.sh` snapshots it.
- **Desktop.** Tag `v0.2.0` on the `desktop` branch. GitHub Actions builds Windows, macOS and Linux installers, signs them if certificates are configured, and drafts a release. The installers have the server URL and manifest public key built in.
- **Updates.** Copy a release's files into the server's `updates/` folder. Running apps pick them up and install on next quit.

## What it can and can't prove

EventKit makes honest behaviour easy to show and casual cheating easy to spot: quitting the app, editing the log or changing the clock all get flagged. It cannot make a laptop the attendee fully controls tamper-proof. A determined person could, for example:

- extract the device key;
- run a modified app;
- route traffic through another device.

Treat **compliant** as "no evidence of a violation" and **violation** as "worth a conversation", not as automatic proof either way.

## Glossary

- **Manifest:** the signed list of exactly what to install.
- **SHA-256:** a file fingerprint. Change one byte and it changes completely.
- **Ed25519:** the signature scheme the server uses to sign the manifest.
- **HMAC:** a keyed fingerprint. It proves who wrote something without revealing the key.
- **Hash chain:** each log line includes the fingerprint of the previous one, so removing a line is detectable.
- **PKCE:** "proof key for code exchange". It ties a sign-in code to the app that started the sign-in.
- **Loopback:** `127.0.0.1`, the laptop talking to itself. It's used to hand the sign-in back from the browser to the app.
- **LAN mirror:** a copy of all downloads on the venue network, so 100 laptops don't share one internet uplink.
