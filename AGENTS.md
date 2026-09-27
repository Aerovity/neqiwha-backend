# Naqiwha backend: rules for agents

Full spec: `../naqiwha-technical-plan.md` (sections 7-9 are the backend). It is the source of truth for data, API and rules,
with these project-specific changes:

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
- NEVER `git push`. Commit locally only.
- Test logins (DEV_TOOLS=true): any `@naqiwha.test` email, code `424242`. Test data must use those emails.
- Keys in `.env` are throwaway: use them, never print or commit them.
- Raw SQL with `postgres` (porsager), camelCase transform on results. `count(*)::int`. JSONB: `${sql.json(x)}` (postgres.js encodes jsonb itself; `JSON.stringify(x)::jsonb` stores a JSON string).
- Gemini: `GEMINI_MODEL` then `GEMINI_FALLBACK_MODELS` (comma list); the key is free tier (20 req/day per model).
- Error responses: `{ error: { code, message } }` via `fail()` from `server/http.ts`; messages are user-facing.
