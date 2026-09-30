# Build Plan

Monorepo (pnpm workspaces, TypeScript everywhere). Build order follows the spec milestones; each milestone ends with a commit.

| #   | Milestone       | Key deliverables                                                                                                                                                                                                                                      |
| --- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Scaffold        | pnpm workspace, tsconfig/eslint/prettier/vitest, `packages/shared` (Zod schemas, types, canonical JSON, Ed25519 manifest signing, rotating QR code, hash chain, compliance policy, Flutter release parser, doctor parser), Prisma schema, seed script |
| 2   | Server core     | Fastify app factory, env config, attendee OTP auth, admin password + TOTP auth, RSVP CSV import, schedule, manifest builder + signing, time endpoint, rate limits, audit log                                                                          |
| 3   | Desktop shell   | electron-vite app, secure preload API, safeStorage session, login screens, setup UI, setup engine (state machine, persisted state, downloader) running in `--simulate` mode                                                                           |
| 4   | Real installers | Component implementations per OS (Windows → Linux → macOS), env/PATH persistence, `flutter doctor -v` gating                                                                                                                                          |
| 5   | Readiness + QR  | Signed readiness report, server gate issuing per-attendee secret, local rotating QR, `/admin/scan` with idempotent check-in                                                                                                                           |
| 6   | Admin web       | Login, overview counters, attendees table + import + drawer, scanner (camera + HID + manual), attendance list + CSV/XLSX export, settings                                                                                                             |
| 7   | Phase 2         | Schedule sync, connectivity monitor, tamper-evident HMAC hash-chained log, realtime + batch upload, server chain verification, monitoring dashboard + export                                                                                          |
| 8   | Ship            | electron-builder config (NSIS one-click, dmg, AppImage, deb), GitHub Actions CI + release, README with event-day runbook, signing/notarization notes                                                                                                  |

## Architecture sketch

```
 ┌──────────────── attendee laptop ────────────────┐        ┌──────────── server (Fastify) ───────────┐
 │ Electron main                                   │ HTTPS  │ /auth/*       OTP login                 │
 │  ├ api client (net.fetch, system proxy)  ───────┼───────►│ /api/manifest signed Ed25519            │
 │  ├ setup engine (state machine, resumable)      │        │ /api/progress /api/readiness (gate)     │
 │  │   └ components: system,git,flutter,java,     │        │ /api/schedule /api/time                 │
 │  │     android,chrome,vscode,devtools,warmup,   │        │ /api/connectivity/{events,log}          │
 │  │     verify                                   │        │ /admin/*  (cookie session, roles)       │
 │  ├ readiness → per-attendee secret (safeStorage)│        │ SSE /admin/stream                       │
 │  ├ QR = attendeeId + HMAC(secret, 60s window)   │        │ Prisma (SQLite dev / Postgres prod)     │
 │  └ phase-2 monitor → HMAC hash-chained log      │        │ /mirror/* optional LAN mirror           │
 │ Preload (typed, minimal) ↔ React renderer       │        └──────────────▲──────────────────────────┘
 └─────────────────────────────────────────────────┘                       │ same origin
                                                          ┌────────────────┴─────────────┐
                                                          │ Admin SPA (React + Vite)     │
                                                          │ scanner, attendance, phase 2 │
                                                          └──────────────────────────────┘
```

See `ASSUMPTIONS.md` for decisions made without asking.
