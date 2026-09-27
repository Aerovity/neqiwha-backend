# Naqiwha — Backend

**Naqiwha** (Algerian Darija, roughly *"clean it up!"*) turns cleaning public spaces into a ranked, social quest. People spot a dirty place on the map, rally others to clean it, check volunteers in with personal QR codes, prove the cleanup with before/after photos judged by AI, and earn XP, ranks and coins they spend at a partner shop.

This repository is the **API**. The web app lives in [neqiwha-frontend](https://github.com/Aerovity/neqiwha-frontend).

**Live app:** https://neqiwha-frontend-production.up.railway.app

---

## How it works

1. **Spot a mess.** A user takes a live BEFORE photo. Gemini checks it and suggests a title and description. The spot is pinned at the user's current GPS position (fresh fix, ≤ 100 m accuracy).
2. **Join.** Other users join the cleanup. A spot can also be a *solo cleanup*: private, anonymous by default, and not joinable.
3. **Check in.** On site, each participant shows their personal QR ticket and the organizer scans it. The first check-in moves the spot to *Cleaning now*.
4. **Finish.** The organizer takes the AFTER photo. Gemini compares it with the BEFORE photo, checking that it is the same place and that it is actually clean. If it passes, the spot is marked cleaned and every checked-in participant is paid XP and coins in a single transaction.
5. **Rank up and spend.** XP drives five ranks, from *Mowatin* to *Khadra bi idn Allah*. Higher ranks multiply rewards and grant coin gifts. Coins buy vouchers from partner shops (a made-up demo catalogue in [`shared/shop.ts`](shared/shop.ts)).

| Rank | Name | Min XP | Multipliers | Level-up gift |
|---|---|---|---|---|
| 0 | Mowatin | 0 | — | — |
| 1 | Civilisé | 100 | — | +100 coins |
| 2 | Nqi w 3lih lklam | 400 | — | +250 coins |
| 3 | Super Dz | 1200 | ×2 coins | +500 coins |
| 4 | Khadra bi idn Allah | 3000 | ×2 XP, ×2 coins | +1000 coins |

Each checked-in participant earns 100 XP and 100 coins per cleanup, and the organizer earns an extra 50 of each. These rules live in [`shared/ranks.ts`](shared/ranks.ts).

## Stack

- **Runtime:** Node 22, TypeScript executed directly with `tsx` (no build step)
- **HTTP:** [Hono](https://hono.dev) on `@hono/node-server`
- **Database:** PostgreSQL via [`postgres`](https://github.com/porsager/postgres) (raw SQL, no ORM)
- **Validation:** Zod
- **AI:** Google Gemini (`@google/genai`), with a chain of fallback models
- **Email:** [Resend](https://resend.com) for passwordless login codes
- **Hosting:** Railway

## Architecture

```
Browser ──► neqiwha-frontend (public)  ──/api/*──►  neqiwha-backend (private network)  ──►  Postgres
             serves the SPA + proxies                Hono API                              
```

The API is **not exposed publicly**. The frontend service proxies `/api/*` to it over Railway's private network, so the browser only ever talks to a single origin. Session cookies stay first-party and no CORS is needed. Don't add CORS.

```
server/
  index.ts        entry point: runs schema init, mounts /api, listens on "::"
  env.ts          Zod-validated environment
  db.ts           postgres client + idempotent schema bootstrap
  schema.sql      tables (CREATE ... IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
  auth.ts         session cookie loading, requireUser / requireAdmin
  http.ts         ApiError + fail() helper
  dto.ts          DB rows → API shapes
  routes/         one router per area (auth, me, events, images, ai, shop, leaderboard, admin, dev, config, health)
  services/       gemini.ts, email.ts, rewards.ts, codes.ts
  scripts/        check-env, seed, clean-test-data, grant-admin
shared/           types, ranks and shop catalogue — a contract shared verbatim with the frontend
scripts/          smoke.ts (end-to-end API regression suite), deploy.sh
test-assets/      before/after photo pairs for testing the AI gate
```

> `shared/` is a frozen contract. It is copied verbatim into `neqiwha-frontend/src/shared/`, so change both together.

The schema is applied automatically on startup. `schema.sql` is idempotent, so there is no separate migration step.

## API

All routes are under `/api`. Errors always have the shape `{ "error": { "code": string, "message": string } }`, and the message is safe to show to users. Request bodies are capped at 8 MB.

| Area | Routes |
|---|---|
| Health / config | `GET /health` (reports the build SHA), `GET /config` (public client config, e.g. Maps key) |
| Auth | `POST /auth/request-code`, `POST /auth/verify-code`, `POST /auth/logout` |
| Me | `GET /me`, `PATCH /me`, `GET /me/history`, `GET /me/events`, `POST /rewards/seen` |
| Images | `POST /images`, `GET /images/:id` |
| AI | `POST /ai/analyze-photo` |
| Spots | `GET /events`, `POST /events`, `GET /events/:id`, `POST/DELETE /events/:id/join`, `POST /events/:id/checkin`, `POST /events/:id/complete` |
| Leaderboard | `GET /leaderboard` |
| Shop | `GET /shop/items`, `POST /shop/purchase`, `GET /vouchers`, `POST /vouchers/:id/use` |
| Admin | `GET /admin/stats`, `GET /admin/events`, `POST /admin/events/:id/close`, `POST /admin/events/:id/reopen`, `DELETE /admin/events/:id`, `GET /admin/users`, `POST /admin/users/:id/admin`, `GET /admin/log` |
| Dev (DEV_TOOLS or DEMO_SAMPLES) | `GET /dev/sample/:name` |

**AI photo gate.** Photos are analysed server-side and the result is stored on the image. Publishing a spot with an unchecked photo returns `400 photo_not_checked`, and a rejected photo returns `422 photo_rejected`. Any AI verdict sent by the client is ignored.

## Getting started

### Prerequisites

- Node 22
- A PostgreSQL database
- API keys for Gemini, Resend and Google Maps

### Setup

```bash
git clone https://github.com/Aerovity/neqiwha-backend.git
cd neqiwha-backend
npm install
cp .env.example .env    # then fill in the values
npm run check:env       # verifies the configuration
npm run dev             # API on http://localhost:8787
```

To run the whole app locally, start the [frontend](https://github.com/Aerovity/neqiwha-frontend) with `npm run dev` as well. Vite proxies `/api` to `:8787`.

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string |
| `SESSION_SECRET` | yes | ≥ 32 chars, e.g. `openssl rand -hex 32` |
| `RESEND_API_KEY` | yes | Resend API key for login-code emails |
| `EMAIL_FROM` | yes | Sender, e.g. `Naqiwha <login@naqiwha.tech>` (domain must be verified in Resend) |
| `GEMINI_API_KEY` | yes | Google Gemini API key |
| `GEMINI_MODEL` | no | Primary model (default `gemini-3.8-flash`) |
| `GEMINI_FALLBACK_MODELS` | no | Comma-separated models tried in order when the primary fails or is out of quota |
| `GOOGLE_MAPS_API_KEY` | yes | Maps JavaScript API key, sent to the client via `/config` |
| `GOOGLE_MAPS_MAP_ID` | no | Map ID for styled/advanced markers (default `DEMO_MAP_ID`) |
| `DEV_TOOLS` | no | `true` enables test logins, sample photos and the `/kit` screen. **Keep it `false` in real production.** |
| `DEMO_SAMPLES` | no | `true` shows the sample-photo buttons in the create and finish flows without enabling test logins (for demos). Samples still go through the AI check. |
| `AI_FAIL_OPEN` | no | `true` lets photos through when Gemini is unavailable (default `false`) |
| `API_PORT` | no | Local dev port (default `8787`). In production `PORT` is used (default `8080`). |
| `TEST_REAL_EMAIL` | no | Address used to test real email delivery |
| `BUILD_SHA` | no | Set by `scripts/deploy.sh` and reported by `/api/health` |

### Test logins

When `DEV_TOOLS=true`, any email ending in `@naqiwha.test` logs in with the code **`424242`** and no email is sent. Test data should always use these addresses so `db:clean-test` can remove it.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Start the API with hot reload (loads `.env`) |
| `npm start` | Start the API (production) |
| `npm run typecheck` | `tsc --noEmit`, which must pass before every commit |
| `npm run check:env` | Validate environment variables |
| `npm run smoke -- <base-url>` | End-to-end API regression suite, e.g. `npm run smoke -- http://localhost:8787` |
| `npm run db:seed` | Seed demo users and spots (idempotent) |
| `npm run db:clean-test` | Delete `@naqiwha.test` users and their data |
| `npm run admin:grant -- <email> [--revoke]` | Grant or revoke admin rights |

`test-assets/` contains four before/after pairs (`beforeN` ↔ `afterN` show the same place). The smoke suite uses them to exercise the AI gate: `beforeN` vs `afterN` should pass, `beforeN` vs `beforeN` means the place is still dirty, and `before1` vs `after2` is a different place.

## Deployment

The API is deployed to Railway as the `neqiwha-backend` service, alongside `neqiwha-frontend` and a Postgres database. [`railway.json`](railway.json) configures Railpack, `npm start` and a health check on `/api/health`.

```bash
./scripts/deploy.sh   # stamps BUILD_SHA with the local commit, then `railway up`
```

After a deploy, `GET /api/health` should report the new SHA.

The smoke suite logs in with `@naqiwha.test` accounts, so it only works against an environment where `DEV_TOOLS=true` (e.g. locally). Production runs with `DEV_TOOLS=false`.

For one-off scripts against the production database (`db:seed`, `db:clean-test`, `admin:grant`), use `railway run` so they pick up the service variables.

## Notes

- The Gemini free tier allows about 20 requests per day per model. The fallback chain spreads calls across several models so that one exhausted model doesn't fail a user request.
- If local scripts hit `UND_ERR_CONNECT_TIMEOUT` on networks with a flaky IPv6 path, set `NODE_OPTIONS=--dns-result-order=ipv4first`.
