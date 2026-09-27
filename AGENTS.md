# Naqiwha backend: rules for agents

See `README.md` for the product, API overview, environment and scripts. Project-specific rules:

- The API is its own Railway service (`neqiwha-backend`). The frontend service proxies `/api/*` to it over the private
  network, so the browser sees one origin. Never add CORS.
- `shared/` is a frozen contract, copied verbatim into `neqiwha-frontend/src/shared/`. Don't change it without the orchestrator.
- Test photos live in `test-assets/` as `before1..4.png` / `after1..4.png` (pair N = same place). "Still dirty" = `beforeN`
  vs `beforeN`; "other place" = `before1` vs `after2`.
- `/api/health` reports `BUILD_SHA` (set by `scripts/deploy.sh`), not a GitHub SHA.

## Commands
- `npm run dev` (API on :8787, loads `.env`; the DB is the shared Railway Postgres via its public URL)
- `npm run typecheck` must pass before every commit
- `npm run smoke -- http://localhost:8787`, `npm run check:env`, `npm run db:seed`, `npm run db:clean-test`

## Rules
- Pushing to GitHub does not deploy: deploys are manual via `scripts/deploy.sh`.
- Test logins (DEV_TOOLS=true, local only; production runs with DEV_TOOLS=false): any `@naqiwha.test` email, code `424242`. Test data must use those emails.
- Never print or commit keys from `.env`.
- Raw SQL with `postgres` (porsager), camelCase transform on results. `count(*)::int`. JSONB: `${sql.json(x)}` (postgres.js encodes jsonb itself; `JSON.stringify(x)::jsonb` stores a JSON string).
- Gemini: `GEMINI_MODEL` then `GEMINI_FALLBACK_MODELS` (comma list); the key is free tier (20 req/day per model).
- Error responses: `{ error: { code, message } }` via `fail()` from `server/http.ts`; messages are user-facing.
