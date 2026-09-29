# Event Chat Implementation Plan

**Goal:** Participants of a public cleanup can chat (text, polling) until 24 h after the spot is cleaned or closed, with own- and admin-deletion, and an hourly job that permanently deletes expired chats.

**Architecture:** Backend: one new table (`event_messages`), one new router (`server/routes/chat.ts`) with three endpoints, one cleanup service started at boot. Frontend: a new `/spots/:id/chat` screen fed by a 3 s polling hook that merges "changed since cursor" pages; entry points on the spot and admin screens.

**Tech Stack:** Backend Hono + postgres.js (raw SQL, camelCase transform) + zod, tsx runtime. Frontend Vite + React 19 + TanStack Query v5 + Tailwind v4 + sonner.

**Spec:** `neqiwha-backend/docs/specs/2026-09-28-event-chat-design.md`. Read it before any task. It holds the access table, the lifetime table and the exact error copy.

**Repos:** Tasks 1–3 run in `C:\Projects\naqiwha\neqiwha-backend`, tasks 4–6 in `C:\Projects\naqiwha\neqiwha-frontend`. Both are on branch `ramzi/dev`. Never touch `main`, never run `scripts/deploy.sh`, and never point `.env` at Railway (local DB is `localhost:5433`).

## Global Constraints

- Schema: append only to `server/schema.sql`, idempotent (`IF NOT EXISTS`); never rename or drop.
- Errors: `fail(status, code, message)` from `server/http.ts`; messages are user-facing plain English, no "sorry", copied verbatim from the spec's error table.
- SQL: raw `sql` tagged templates, `count(*)::int`, results are camelCase.
- `shared/`: add `shared/chat.ts`; the only edit to an existing file is adding `'delete_message'` to `AdminAction['action']` in `shared/types.ts`. Frontend copies (`src/shared/`) must be byte-identical to the backend's.
- Message body: trimmed, 1–500 characters (`string.length`). Rate limit: ≥ 10 messages by the same user in the same event within 30 s → 429.
- Chat window: `endsAt = COALESCE(closed_at, cleaned_at)`; expired when `endsAt <= now() - 24h`; `closesAt = endsAt + 24h`.
- Polling interval 3000 ms; first load returns the most recent 200 messages; `since` uses a 5-second overlap.
- Frontend: all data hooks in `src/lib/queries.ts`; screens in `src/screens/`; every mutation shows a `sonner` toast on error; buttons loading and disabled while pending; tap targets ≥ 44 px; mobile first 390×844, check 360 px.
- Before every commit: backend `npm run typecheck`; frontend `npm run typecheck && npm run build`.

## Review Focus

1. **Arabic / RTL messages:** users write in Arabic or Darija, and bubbles must render right-to-left text correctly. Task 5: bubbles use `dir="auto"`.
2. **Long unbroken strings (URLs, "loooool"):** must wrap inside the bubble, not widen the page. Task 5: bubble text has `[overflow-wrap:anywhere]`; manual check with a 200-char URL at 360 px.
3. **Double send (double tap / Enter while pending):** must post once. Task 5: `send()` returns early when `sendMessage.isPending`; manual check.
4. **Viewer leaves the event while the chat is open:** the next poll gets 403, and the screen must stop polling and show the join prompt, not a spinner or a toast loop. Task 4: `refetchInterval` returns `false` once the query has an error; Task 5 renders the 403 state. Task 1 smoke asserts the 403 after leaving.
5. **Less than one hour left:** the countdown must say "less than an hour", not "0 h". Task 4: `formatClosesIn()` handles `< 1 h`.

---

### Task 1: Contract, table, and read/post endpoints

**Files:**
- Create: `shared/chat.ts`, `server/routes/chat.ts`
- Modify: `shared/types.ts` (`AdminAction['action']` union), `server/schema.sql` (append), `server/routes/index.ts` (mount), `scripts/smoke.ts` (chat steps)

**Interfaces:**
- Produces (`shared/chat.ts`): `ChatState`, `ChatMessage`, `ChatPage`, exactly as in the spec's "Shared contract" block.
- Produces (`server/routes/chat.ts`):
  - `export const chatRoutes: Hono<AppEnv>`
  - `type ChatCtx = { eventId: string; title: string; organizerId: string; state: ChatState; closesAt: Date | null; isParticipant: boolean; isAdmin: boolean }`
  - `async function loadChat(eventId: string, me: UserRow): Promise<ChatCtx>`: order of checks: 404 `not_found` → 409 `solo_cleanup` → 403 `not_participant` (unless admin) → 410 `chat_closed`.
  - `async function selectMessages(ctx: ChatCtx, meId: string, where: 'recent' | { since: string } | { id: string }): Promise<ChatMessage[]>`: one query joining `users`; `author` via `toPublicUser` (null when `user_id` is null); `deleted` = `deletedAt ? (deletedByAdmin ? 'moderator' : 'author') : null`; `canDelete` per spec.
  - `async function nextCursor(): Promise<string>`: `SELECT (clock_timestamp() - interval '5 seconds')::text AS c`. The overlap is built into the cursor (not into the filter), so a quiet chat returns nothing and re-sent rows stop within ~2 polls.

- [ ] **Step 1: Add the contract.** Create `shared/chat.ts` from the spec block; add `| 'delete_message'` to `AdminAction['action']` in `shared/types.ts`.

- [ ] **Step 2: Append the table** to `server/schema.sql`, exactly the spec's SQL (with its comment line).

- [ ] **Step 3: Write the failing smoke steps.** In `scripts/smoke.ts`, after the step `'v2 B leaves → count 1, then joins again → 2'`, add (import `ChatMessage, ChatPage` from `'../shared/chat'`):

```ts
const msgs = (id: string) => `/events/${id}/messages`;

await step('v2 chat: participants post + read; outsiders 403; logged out 401', async () => {
  const a1 = await A.ok<ChatMessage>('POST', msgs(spot.id), { body: '  Yallah, 10am at the gate  ' }, 201);
  eq(a1.body, 'Yallah, 10am at the gate', 'body is trimmed');
  eq(a1.mine, true, 'a1.mine'); eq(a1.isOrganizer, true, 'a1.isOrganizer'); eq(a1.deleted, null, 'a1.deleted');
  await B.ok<ChatMessage>('POST', msgs(spot.id), { body: 'مرحبا 👋' }, 201);
  const page = await B.ok<ChatPage>('GET', msgs(spot.id));
  eq(page.messages.length, 2, 'B sees 2 messages');
  eq(page.messages[0].id, a1.id, 'oldest first');
  eq(page.messages[0].mine, false, 'A message not mine for B');
  eq(page.state, 'open', 'state'); eq(page.canPost, true, 'canPost'); eq(page.closesAt, null, 'closesAt');
  expect(typeof page.cursor === 'string' && page.cursor.length > 0, 'cursor');
  await C.fails('GET', msgs(spot.id), undefined, 403, 'not_participant');
  await C.fails('POST', msgs(spot.id), { body: 'hi' }, 403, 'not_participant');
  await new Client('anon', '').fails('GET', msgs(spot.id), undefined, 401, 'unauthorized');
});

await step('v2 chat: validation 400 and rate limit 429', async () => {
  await B.fails('POST', msgs(spot.id), { body: '   ' }, 400, 'invalid_message');
  await B.fails('POST', msgs(spot.id), { body: 'x'.repeat(501) }, 400, 'invalid_message');
  await B.ok('POST', msgs(spot.id), { body: 'x'.repeat(500) }, 201);
  // B has 2 messages in the last 30 s; 8 more reach the limit of 10.
  for (let i = 0; i < 8; i++) await B.ok('POST', msgs(spot.id), { body: `spam ${i}` }, 201);
  await B.fails('POST', msgs(spot.id), { body: 'one too many' }, 429, 'slow_down');
});

await step('v2 chat: solo 409; left participant 403; admin non-participant reads but cannot post', async () => {
  // soloSpot: reuse the solo spot created in 'v2 solo spot' (hoist its variable if it's block-scoped).
  await A.fails('GET', msgs(soloSpot.id), undefined, 409, 'solo_cleanup');
  await D.ok('POST', `/events/${spot.id}/join`);
  await D.ok('GET', msgs(spot.id));
  await D.ok('DELETE', `/events/${spot.id}/join`);
  await D.fails('GET', msgs(spot.id), undefined, 403, 'not_participant');
  await sql`UPDATE users SET is_admin = true WHERE id = ${meC.id}`;
  const asAdmin = await C.ok<ChatPage>('GET', msgs(spot.id));
  eq(asAdmin.canPost, false, 'admin non-participant canPost');
  await C.fails('POST', msgs(spot.id), { body: 'hi' }, 403, 'not_participant');
  await sql`UPDATE users SET is_admin = false WHERE id = ${meC.id}`;
});

await step('v2 chat: closed spot is read-only; reopen restores posting; expired → 410', async () => {
  const photo = await A.upload('before3'); await approve(photo.id);
  const s = await A.ok<EventDetail>('POST', '/events', { ...spotBody, title: `${title} chat`, beforeImageId: photo.id }, 201);
  await B.ok('POST', `/events/${s.id}/join`);
  await B.ok('POST', msgs(s.id), { body: 'before close' }, 201);
  await A.ok('POST', `/admin/events/${s.id}/close`);
  const closed = await B.ok<ChatPage>('GET', msgs(s.id));
  eq(closed.state, 'closed', 'state closed'); eq(closed.canPost, false, 'canPost closed');
  expect(closed.closesAt && Date.parse(closed.closesAt) > Date.now() + 23 * 3600e3, 'closesAt ≈ +24 h');
  await B.fails('POST', msgs(s.id), { body: 'x' }, 409, 'event_closed');
  await A.ok('POST', `/admin/events/${s.id}/reopen`);
  await B.ok('POST', msgs(s.id), { body: 'after reopen' }, 201);
  await sql`UPDATE events SET status = 'cleaned', cleaned_at = now() - interval '25 hours' WHERE id = ${s.id}`;
  await B.fails('GET', msgs(s.id), undefined, 410, 'chat_closed');
  await B.fails('POST', msgs(s.id), { body: 'x' }, 410, 'chat_closed');
  chatExpiredSpotId = s.id; // declared `let chatExpiredSpotId = ''` near the top of main(); used in Task 3
});
```

If the names `spot`, `spotBody`, `title`, `soloSpot`, `meC` differ in `smoke.ts`, use the existing ones. The assertions stay as written.

- [ ] **Step 4: Run it and watch it fail.** Backend dev server running (`npm run dev`), then:
Run: `SMOKE_NO_AI=1 npm run smoke -- http://localhost:8787`
Expected: `❌ SMOKE FAILED` at `v2 chat: participants post + read…` with `expected 201, got 404 … Unknown API route`.

- [ ] **Step 5: Implement `server/routes/chat.ts`** and mount it in `server/routes/index.ts` (`api.route('/', chatRoutes)` after `eventRoutes`).
  - `GET /events/:id/messages`: `loadChat` → `selectMessages(ctx, me.id, 'recent')` (latest 200 by `created_at DESC, id DESC`, returned reversed). `since` is handled in Task 2, so ignore it here. Build `ChatPage` with `canPost = isParticipant && state !== 'closed'`, `closesAt` ISO or null, `cursor = await nextCursor()`.
  - `POST /events/:id/messages`: zod `{ body: z.string().trim().min(1, MSG).max(500, MSG) }`, where `MSG` = "Write a message (1–500 characters)." (use code `invalid_message`: call `schema.safeParse` and `fail(400, 'invalid_message', MSG)`, since `parse()` hard-codes `invalid_input`). Then 403 if not a participant, 409 `event_closed` (existing copy "A moderator closed this spot.") if state `closed`, the rate-limit count (`created_at > now() - interval '30 seconds'`, deleted rows included) → 429, `INSERT … RETURNING id`, respond 201 with `selectMessages(ctx, me.id, { id })[0]`.
  - Lifetime math lives in one pure helper in the same file: `chatWindow(ev: { status: EventStatus; cleanedAt: Date | null; closedAt: Date | null }, now = new Date()): { state: ChatState; closesAt: Date | null; expired: boolean }`.

- [ ] **Step 6: Run it and check it passes.**
Run: `npm run typecheck && SMOKE_NO_AI=1 npm run smoke -- http://localhost:8787`
Expected: typecheck clean; `✅ SMOKE PASSED`.

- [ ] **Step 7: Commit.**
```bash
git add shared/ server/schema.sql server/routes/chat.ts server/routes/index.ts scripts/smoke.ts
git commit -m "Add event chat: table, contract, read and post endpoints"
```

---

### Task 2: Incremental polling (`since`) and message deletion

**Files:**
- Modify: `server/routes/chat.ts`, `server/routes/admin.ts` (export `logAction`), `scripts/smoke.ts`

**Interfaces:**
- Consumes: `loadChat`, `selectMessages`, `nextCursor`, `ChatCtx` from Task 1; `logAction(adminId, action, targetType, targetId, detail)` from `routes/admin.ts`.
- Produces: `GET …/messages?since=<cursor>` and `DELETE /events/:id/messages/:messageId` per the spec.

- [ ] **Step 1: Write the failing smoke steps** (after Task 1's steps, before the closed-spot step):

```ts
await step('v2 chat: since returns only changes, including deletions', async () => {
  const first = await A.ok<ChatPage>('GET', msgs(spot.id));
  await new Promise(r => setTimeout(r, 6000)); // let the 5 s overlap pass
  const settle = await A.ok<ChatPage>('GET', `${msgs(spot.id)}?since=${encodeURIComponent(first.cursor)}`);
  expect(settle.messages.every(m => first.messages.some(f => f.id === m.id)), 'settle poll returned only overlap rows');
  const quiet = await A.ok<ChatPage>('GET', `${msgs(spot.id)}?since=${encodeURIComponent(settle.cursor)}`);
  eq(quiet.messages.length, 0, 'nothing changed → empty');
  const bMsg = first.messages.find(m => !m.mine && !m.deleted)!;
  const del = await B.ok<ChatMessage>('DELETE', `${msgs(spot.id)}/${bMsg.id}`);
  eq(del.deleted, 'author', 'deleted by author'); eq(del.body, '', 'body wiped'); eq(del.canDelete, false, 'canDelete after delete');
  const next = await A.ok<ChatPage>('GET', `${msgs(spot.id)}?since=${encodeURIComponent(quiet.cursor)}`);
  const seen = next.messages.find(m => m.id === bMsg.id);
  expect(seen && seen.deleted === 'author' && seen.body === '', 'deletion visible to A via since');
  const [row] = await sql`SELECT body FROM event_messages WHERE id = ${bMsg.id}`;
  eq(row.body, '', 'body wiped in DB');
  await B.ok<ChatMessage>('DELETE', `${msgs(spot.id)}/${bMsg.id}`); // idempotent
  await A.ok('GET', `${msgs(spot.id)}?since=garbage`); // invalid since is ignored
});

await step('v2 chat: delete permissions; admin delete is logged', async () => {
  const b = await B.ok<ChatMessage>('POST', msgs(spot.id), { body: 'delete me, mod' }, 201).catch(async () => {
    await new Promise(r => setTimeout(r, 30_000)); // rate-limit window from the 429 step
    return B.ok<ChatMessage>('POST', msgs(spot.id), { body: 'delete me, mod' }, 201);
  });
  await D.fails('DELETE', `${msgs(spot.id)}/${b.id}`, undefined, 403, 'not_participant');
  await sql`UPDATE users SET is_admin = false WHERE id = ${meA.id}`;
  await A.fails('DELETE', `${msgs(spot.id)}/${b.id}`, undefined, 403, 'not_author');
  await sql`UPDATE users SET is_admin = true WHERE id = ${meA.id}`;
  const asA = await A.ok<ChatPage>('GET', msgs(spot.id));
  eq(asA.messages.find(m => m.id === b.id)?.canDelete, true, 'admin canDelete');
  const mod = await A.ok<ChatMessage>('DELETE', `${msgs(spot.id)}/${b.id}`);
  eq(mod.deleted, 'moderator', 'deleted by moderator');
  const log = await A.ok<AdminAction[]>('GET', '/admin/log');
  const entry = log.find(l => l.action === 'delete_message' && l.targetId === spot.id);
  expect(entry, 'delete_message not in audit log');
  expect(!JSON.stringify(entry).includes('delete me, mod'), 'message text leaked into audit log');
  await A.fails('DELETE', `${msgs(spot.id)}/00000000-0000-0000-0000-000000000000`, undefined, 404, 'message_not_found');
});
```

- [ ] **Step 2: Run and watch it fail.** Same command. Expected: FAIL at `since returns only changes` (`nothing changed → empty`: got the full list).

- [ ] **Step 3: Implement.**
  - `since`: accept only values matching `/^\d{4}-\d{2}-\d{2}[ T][\d:.]+(Z|[+-]\d{2}(:?\d{2})?)?$/`; otherwise treat as first load. Filter `updated_at > ${since}::timestamptz` (the cursor already carries the 5 s overlap), ordered `created_at, id`, no limit.
  - `DELETE`: load the message (`id` and `event_id` must match, bad uuid → 404 `message_not_found`); already deleted → return it; author path requires `isParticipant` (else 403 `not_participant` from `loadChat`) and state ≠ `closed` (409 `event_closed`); non-author non-admin → 403 `not_author`; `UPDATE … SET body = '', deleted_at = now(), updated_at = clock_timestamp(), deleted_by_admin = (user_id IS DISTINCT FROM ${me.id})`; if deleted by an admin who isn't the author → `logAction(me.id, 'delete_message', 'event', ctx.eventId, { title: ctx.title })`.
  - Export `logAction` from `routes/admin.ts` (no other change there).

- [ ] **Step 4: Run and check it passes.** `npm run typecheck && SMOKE_NO_AI=1 npm run smoke -- http://localhost:8787` → `✅ SMOKE PASSED`.

- [ ] **Step 5: Commit.** `git commit -m "Event chat: incremental polling and message deletion"` (files: `server/routes/chat.ts server/routes/admin.ts scripts/smoke.ts`).

---

### Task 3: Hourly cleanup job

**Files:**
- Create: `server/services/chat-cleanup.ts`
- Modify: `server/index.ts`, `scripts/smoke.ts`

**Interfaces:**
- Produces: `export async function deleteExpiredMessages(): Promise<number>` (the spec's DELETE; returns `count`); `export function startChatCleanup(): void` (runs once now, then every `60 * 60 * 1000` ms via `setInterval(...).unref()`; catches and `console.error`s failures; logs `chat cleanup: deleted N messages` when N > 0).

- [ ] **Step 1: Failing smoke step** (after the closed/expired step; `chatExpiredSpotId` comes from Task 1):

```ts
await step('v2 chat: cleanup job deletes expired chats only', async () => {
  const { deleteExpiredMessages } = await import('../server/services/chat-cleanup');
  const removed = await deleteExpiredMessages();
  expect(removed >= 2, `expected ≥ 2 expired rows removed, got ${removed}`);
  const [left] = await sql`SELECT count(*)::int AS n FROM event_messages WHERE event_id = ${chatExpiredSpotId}`;
  eq(left.n, 0, 'expired chat rows');
  const [live] = await sql`SELECT count(*)::int AS n FROM event_messages WHERE event_id = ${spot.id}`;
  expect(live.n > 0, 'live chat was deleted');
});
```

- [ ] **Step 2: Run, expect FAIL** (`Cannot find module …chat-cleanup`).
- [ ] **Step 3: Implement** `server/services/chat-cleanup.ts`; call `startChatCleanup()` in `server/index.ts` right after `await initSchema()`.
- [ ] **Step 4: Run, expect PASS** (restart `npm run dev` first; the boot log shows no error).
- [ ] **Step 5: Commit** `git commit -m "Event chat: hourly cleanup of expired chats"`.

---

### Task 4: Frontend contract, chat helpers, and data hooks

**Files:**
- Create: `src/shared/chat.ts` (copy of backend `shared/chat.ts`), `src/lib/chat.ts`
- Modify: `src/shared/types.ts` (same one-word union change as backend), `src/lib/queries.ts`, `src/screens/AdminScreen.tsx` (`LOG_VERB.delete_message = 'removed a chat message in'`, `LOG_ICON.delete_message = <MessageSquareX size={16} />` from lucide-react; required for the `Record` types to compile)

**Interfaces:**
- Produces (`src/lib/chat.ts`):
  - `type ChatView = { messages: ChatMessage[]; cursor: string; state: ChatState; canPost: boolean; closesAt: string | null }`
  - `mergeChat(prev: ChatView | undefined, page: ChatPage): ChatView`: replaces by `id`, sorts by `createdAt` then `id`, takes `cursor/state/canPost/closesAt` from `page`.
  - `chatClosesAt(ev: EventDetail): Date | null`: `(closedAt ?? cleanedAt) + 24 h`, or null.
  - `chatAvailable(ev: EventDetail, isAdmin: boolean): boolean`: `ev.isPublic && (ev.viewer?.hasJoined || isAdmin) && !(closesAt && closesAt <= now)`.
  - `formatClosesIn(closesAt: string, now = Date.now()): string`: `"less than an hour"` when < 1 h, else `"{n} h"` with `n = Math.floor(hours)`.
- Produces (`src/lib/queries.ts`):
  - `useChat(eventId: string | undefined)`: `queryKey ['chat', id]`; `queryFn` reads `qc.getQueryData<ChatView>(key)`, calls `/events/${id}/messages` with `?since=` when there is a cursor, returns `mergeChat(prev, page)`; `refetchInterval: q => (q.state.error ? false : 3000)`; `retry: (n, err) => !(err instanceof ApiError && [401, 403, 404, 409, 410].includes(err.status)) && n < 1`.
  - `useSendMessage(eventId: string)`: POST `{ body }` → `setQueryData(['chat', id], v => v && mergeChat(v, { ...v, messages: [msg] }))`; `onError` toast.
  - `useDeleteMessage(eventId: string)`: DELETE → same merge; `onSuccess` toast "Message deleted."; `onError` toast.

- [ ] **Step 1: Copy the contract.** `cp ../neqiwha-backend/shared/chat.ts src/shared/chat.ts && cp ../neqiwha-backend/shared/types.ts src/shared/types.ts`. Verify: `diff -r ../neqiwha-backend/shared src/shared` prints nothing.
- [ ] **Step 2: Implement** `src/lib/chat.ts`, the three hooks, and the two `AdminScreen` map entries.
- [ ] **Step 3: Verify.** `npm run typecheck && npm run build`. Expected: both succeed. (The frontend has no unit-test runner; `mergeChat` gets exercised in Task 6's manual run.)
- [ ] **Step 4: Commit** `git commit -m "Event chat: shared contract, merge helpers, polling hooks"`.

---

### Task 5: Chat screen

**Files:**
- Create: `src/screens/ChatScreen.tsx`
- Modify: `src/App.tsx` (protected route `/spots/:id/chat`, next to `/spots/:id/checkin`)

**Interfaces:**
- Consumes: `useChat`, `useSendMessage`, `useDeleteMessage`, `useEvent`, `useMe`; `formatClosesIn`; `groupByDay` from `screens/parts/groupByDay.ts`; components `ScreenHeader` (`back={`/spots/${id}`}`), `Avatar`, `ConfirmSheet` (`tone="danger"`), `EmptyState`, `Notice`, `Button`.

- [ ] **Step 1: Build the screen** to the spec's "Chat screen" section, plus:
  - Layout: `min-h-dvh` column; header; scrollable list (`flex-1 overflow-y-auto`); composer pinned with `pb-[max(env(safe-area-inset-bottom),0.75rem)]`.
  - Bubbles: `dir="auto"` and `[overflow-wrap:anywhere] whitespace-pre-wrap`. Author `null` → name "Former hero".
  - Error states from `useChat().error` (`ApiError.status`): 403 → `EmptyState` "Join this spot to see its chat." + button to the spot; 410 → "This chat has closed." + button to the spot; other → `EmptyState` with a retry button.
  - Banners: `state === 'cleaned'` → `Notice tone="success"` "Saha! Spot cleaned. This chat closes in {formatClosesIn(closesAt)}."; `'closed'` → `Notice tone="danger"` "A moderator closed this spot. The chat is read-only."; admin who isn't a participant (`useEvent` `viewer.hasJoined === false` and `me.isAdmin`) → "You're viewing as a moderator."
  - Composer (only if `canPost`): textarea `maxLength={500}`, auto-grows to 5 lines, Enter sends / Shift+Enter newline; `send()` returns early if the trimmed text is empty or `sendMessage.isPending`; the counter `{n}/500` shows from 450; clear the input on success only.
  - Delete: ⋯ `IconButton` (≥ 44 px) on messages with `canDelete`, plus long-press (500 ms, touch) → `ConfirmSheet` "Delete this message?" / confirm "Delete".
  - Scroll: stick to the bottom when the user is within 80 px of it; otherwise show a "New messages ↓" pill when the message count grows; the first load scrolls to the bottom without animation; smooth scrolling only when `prefers-reduced-motion` isn't set.
- [ ] **Step 2: Verify.** `npm run typecheck && npm run build` succeed.
- [ ] **Step 3: Commit** `git commit -m "Event chat: chat screen"`.

---

### Task 6: Entry points and end-to-end check

**Files:**
- Modify: `src/screens/SpotScreen.tsx` (a "Chat" button above the `BottomBar` actions, or next to them, shown when `chatAvailable(spot, !!me.data?.isAdmin)`; `ButtonLink` to `/spots/${spot.id}/chat` with the lucide `MessageCircle` icon), `src/screens/AdminScreen.tsx` (`SpotRow`: a `ButtonLink size="sm" variant="secondary"` "Chat" before Close/Reopen when `ev.isPublic`)

- [ ] **Step 1: Implement** both entry points.
- [ ] **Step 2: Verify the build.** `npm run typecheck && npm run build` succeed.
- [ ] **Step 3: Manual end-to-end** (both dev servers running, local DB). Two windows (one normal, one private): `ramzi@naqiwha.test` creates a public spot; `friend@naqiwha.test` joins. Check each:
  - Both see the Chat button; messages from each appear in the other window within ~3 s.
  - Arabic text renders RTL; a 200-char URL wraps at 360 px; a double-tap on send posts once.
  - Deleting your own message shows "Message deleted" in both windows.
  - Grant admin (`npm run admin:grant -- ramzi@naqiwha.test` in the backend), delete the friend's message → "Removed by a moderator"; the Admin → Log tab shows "removed a chat message in <spot>"; the Admin → Spots row has a Chat link.
  - The friend leaves the spot while the chat is open → within ~3 s the join prompt appears and polling stops (DevTools Network is quiet).
  - Mark the spot cleaned in the DB (`UPDATE events SET status='cleaned', cleaned_at=now() - interval '23 hours 30 minutes' WHERE id='…'`) → the banner reads "closes in less than an hour".
  - 390×844 and 360 px widths; the keyboard doesn't cover the composer (DevTools device mode).
- [ ] **Step 4: Commit** `git commit -m "Event chat: entry points on spot and admin screens"`.
- [ ] **Step 5: Final checks and handoff.** Backend: `npm run typecheck && SMOKE_NO_AI=1 npm run smoke -- http://localhost:8787` passes. `git status` is clean in both repos. Ask Ramzi before pushing `ramzi/dev` in both repos.
