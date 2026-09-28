# Event chat: design

- **Date:** 2026-09-28
- **Author:** Ramzi (`ramzi/dev`)
- **Repos:** `neqiwha-backend` and `neqiwha-frontend` (same branch name in both)

## Goal

People who join the same **public** cleanup can talk to each other: to agree on meeting details, say they're running late, or
share updates while cleaning. The chat lives only as long as it's useful. It stays open until **24 hours after the spot is verified
clean**, and then it's deleted so the database doesn't keep data nobody needs.

## Scope

In:
- Plain-text messages (1–500 characters) between participants of a public event.
- Authors can delete their own messages, and admins can delete any message (logged in the admin log).
- Near-real-time updates by polling.
- Automatic, permanent deletion 24 hours after the spot is cleaned or closed by a moderator.

Out (not in this version): photos/attachments, reactions, replies/threads, push notifications, unread badges, editing messages,
reporting, loading history older than the most recent 200 messages.

## Rules

### Who can access a chat

| Viewer | Read | Post | Delete |
|---|---|---|---|
| Participant (organizer or member) of a public event | yes | yes, while the chat is open | own messages |
| Admin (`users.is_admin`) | any public event | only if they are a participant | any message |
| Anyone else, logged in | no (403 `not_participant`) | no | no |
| Logged out | no (401, via `requireUser`) | no | no |

Solo spots (`is_public = false`) have no chat: every endpoint answers 409 `solo_cleanup` with the existing message.
A participant who leaves the event (`DELETE /events/:id/join`) loses access immediately. Their existing messages stay in the
thread, still shown under their name.

### Chat lifetime

With `endsAt = COALESCE(closed_at, cleaned_at)`:

| Event state | Chat state | Read | Post / delete own |
|---|---|---|---|
| `open` or `in_progress`, not closed | `open` | yes | yes |
| `cleaned`, `cleaned_at > now() - 24h`, not closed | `cleaned` | yes | yes |
| closed by a moderator, `closed_at > now() - 24h` | `closed` | yes | **no** (409 `event_closed`) |
| `endsAt <= now() - 24h` | expired | 410 `chat_closed` | 410 `chat_closed` |

If an admin reopens a closed spot (which clears `closed_at`), the chat follows the event's state again. Messages already deleted
by the cleanup job stay deleted.

`closesAt = endsAt + 24h` (null while the event is open). The UI uses it to show "This chat closes in 23 h".

Admins deleting messages is allowed in every non-expired state, including `closed`, since that's when moderation is most
likely to be needed.

## Backend (`neqiwha-backend`)

### Schema (`server/schema.sql`, append only)

```sql
-- Event chat: participants of public spots; deleted 24 h after the spot is cleaned or closed (services/chat-cleanup.ts).
CREATE TABLE IF NOT EXISTS event_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  body              TEXT NOT NULL,          -- '' once deleted
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  deleted_at        TIMESTAMPTZ,
  deleted_by_admin  BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS event_messages_event_idx ON event_messages (event_id, updated_at);
```

A deleted message keeps its row (so other clients learn about the deletion while polling), but its `body` is set to `''` in
the same `UPDATE`. The text is gone from the database immediately.

### Shared contract (`shared/chat.ts`, new file, copied verbatim to `neqiwha-frontend/src/shared/chat.ts`)

Chat types go in a separate new file to keep changes to the frozen contract minimal and avoid merge conflicts with anyone
else editing `types.ts`. The **one unavoidable edit** to an existing file is additive: `'delete_message'` is added to the
`AdminAction['action']` union in `shared/types.ts` (both copies, identical), because the admin log is typed against it.
Mention both in the PR description for whoever maintains `shared/`.

```ts
import type { PublicUser } from './types';

export type ChatState = 'open' | 'cleaned' | 'closed';

export interface ChatMessage {
  id: string;
  author: PublicUser | null;     // null = the author's account was deleted
  isOrganizer: boolean;          // author is the event's organizer
  body: string;                  // '' when deleted
  createdAt: string;             // ISO
  deleted: null | 'author' | 'moderator';
  mine: boolean;                 // viewer wrote it
  canDelete: boolean;            // viewer may delete it now (own message, or viewer is admin; never when already deleted)
}

export interface ChatPage {
  messages: ChatMessage[];       // oldest first; with ?since, only messages created or deleted since the cursor
  cursor: string;                // opaque; send back as ?since=
  state: ChatState;
  canPost: boolean;              // viewer is a participant and state !== 'closed'
  closesAt: string | null;       // ISO; null while the event is open
}
```

### Endpoints (`server/routes/chat.ts`, mounted in `server/routes/index.ts`)

Same style as `routes/events.ts`: `requireUser`, `fail()`, zod via `parse()`, raw SQL with `sql`, `isUuid` checks.
A shared `loadChat(eventId, me)` helper loads the event plus the viewer's participation, applies the lifetime and access
tables above, and returns `{ state, closesAt, isParticipant, isAdmin, organizerId }` or fails.

**`GET /events/:id/messages?since=<cursor>`** returns a `ChatPage`.
- Without `since`: the most recent 200 messages (including deleted placeholders), oldest first.
- With `since`: messages with `updated_at > since - 5 seconds`, oldest first. The 5-second overlap covers rows committed
  slightly out of order. Clients merge by `id`, so duplicates don't matter.
- `cursor` = the greatest `updated_at` among the returned rows, as Postgres text (microsecond precision), or the incoming
  `since` if nothing changed. With no rows at all, it's `now()` as text.
- An invalid `since` is ignored (treated as a first load).

**`POST /events/:id/messages`**, body `{ body: string }`, returns 201 `ChatMessage`.
- Body is trimmed. 1–500 characters, otherwise 400 `invalid_message` "Write a message (1–500 characters)."
- Requires participant + state `open`/`cleaned`.
- Rate limit: if the viewer has sent ≥ 10 messages in this event in the last 30 s, 429 `slow_down`
  "Slow down a little — try again in a few seconds." (counted in SQL, no in-memory state).

**`DELETE /events/:id/messages/:messageId`** returns the updated `ChatMessage`.
- Message must belong to the event, otherwise 404 `message_not_found` "This message doesn't exist anymore."
- Author (participant, state not `closed`) or admin (any non-expired state), otherwise 403 `not_author`
  "You can only delete your own messages."
- Already deleted: returns it unchanged (idempotent).
- Sets `body = ''`, `deleted_at = now()`, `updated_at = clock_timestamp()`, `deleted_by_admin = (deleter is not the author)`.
- When an admin deletes someone else's message, it's logged with the existing `logAction()` in `routes/admin.ts` (exported
  for this, not duplicated): `action = 'delete_message'`, `target_type = 'event'`, `target_id = eventId`,
  `detail = { title: <event title> }`. The message text is **not** copied into the audit log, which is kept forever. That
  would defeat the 24-hour deletion policy. The Log tab then reads "Admin removed a chat message in <spot title>" and links to
  the spot like other event actions.

Error table (all through `fail()`, user-facing English):

| Case | Status / code | Message |
|---|---|---|
| Event missing / bad id | 404 `not_found` | existing `NOT_FOUND` text |
| Solo spot | 409 `solo_cleanup` | existing `SOLO` text |
| Not a participant and not admin | 403 `not_participant` | "Join this spot to see its chat." |
| Post while closed | 409 `event_closed` | existing `CLOSED` text |
| Expired | 410 `chat_closed` | "This chat has closed." |
| Bad body | 400 `invalid_message` | "Write a message (1–500 characters)." |
| Rate limit | 429 `slow_down` | "Slow down a little — try again in a few seconds." |
| Not author / not admin | 403 `not_author` | "You can only delete your own messages." |
| Unknown message | 404 `message_not_found` | "This message doesn't exist anymore." |

### Cleanup job (`server/services/chat-cleanup.ts`)

```sql
DELETE FROM event_messages m USING events e
 WHERE m.event_id = e.id
   AND COALESCE(e.closed_at, e.cleaned_at) <= now() - interval '24 hours'
```

`startChatCleanup()` runs it once at boot (after `initSchema()` in `server/index.ts`), then every hour (`setInterval`, `unref()`).
Errors are logged and don't crash the server. It logs how many rows it deleted when that number is > 0.
Users are protected even if the job is late, because the API already answers 410 for expired chats.

## Frontend (`neqiwha-frontend`)

### Route and entry points
- New protected route `/spots/:id/chat` → `src/screens/ChatScreen.tsx`, registered next to `/spots/:id/checkin` in `App.tsx`.
- **Spot screen** (`SpotScreen.tsx`): a "Chat" button, shown when the event is public and `viewer.hasJoined` (or the viewer is
  an admin), and the chat isn't expired. Expiry is computed from `EventDetail.cleanedAt` / `closedAt` + 24 h, so no contract
  change is needed.
- **Admin screen** (`AdminScreen.tsx`, Spots tab): a "Chat" link for each public spot. Log tab: add the `delete_message`
  label ("removed a chat message in") and icon to its action maps.

### Chat screen
- Header: back arrow, spot title, participant count (from `useEvent`).
- Message list, oldest at the top, grouped by day (reuse `screens/parts/groupByDay.ts`):
  - own messages right-aligned in brand colour; others left-aligned with `Avatar` + display name, plus an "Organizer" tag
    when `isOrganizer`.
  - deleted messages show a muted, italic placeholder: "Message deleted" / "Removed by a moderator".
  - `canDelete` messages: long-press or a ⋯ button opens `ConfirmSheet` ("Delete this message?"). A destructive
    action, so red per the colour rules.
- Banners: state `cleaned`: "Saha! Spot cleaned. This chat closes in {n} h." State `closed`: "A moderator closed this spot.
  The chat is read-only." Admins who aren't participants: "You're viewing as a moderator."
- Empty state: "No messages yet. Say salam to your crew 👋".
- Composer (only when `canPost`): pinned to the bottom with safe-area padding, auto-growing textarea, send button (≥ 44 px, loading
  and disabled while pending), character counter from 450 characters.
- Scrolling: stick to the bottom as messages arrive unless the user has scrolled up. Then show a "New messages ↓" pill.
- 410 response: replace the list with an `EmptyState` "This chat has closed." and a button back to the spot.
- Mobile first (390×844, check 360 px), `min-h-dvh`, `prefers-reduced-motion` respected, toasts on every mutation (`sonner`).

### Data (`src/lib/queries.ts`)
- `useChat(eventId)`: TanStack Query with `refetchInterval: 3000` (stops when the tab is hidden, which is TanStack's default,
  and on 410). It keeps the cursor and a map of messages by `id`, merges each `ChatPage` into it, and exposes the sorted list
  plus `state`, `canPost`, `closesAt`.
- `useSendMessage(eventId)` and `useDeleteMessage(eventId)`: mutations that merge the returned message into the cache right
  away, with toasts on error.

## Testing

**Backend smoke suite (`scripts/smoke.ts`)**, written before the endpoints, using the suite's existing users and `step()`:
1. Participants A and B post; both see both messages; C (not joined) gets 403; logged out gets 401.
2. `since` returns only changes: after B deletes their message, A's next poll includes it with `deleted: 'author'` and `body: ''`.
3. A can't delete B's message (403). An admin can (`deleted: 'moderator'`), and `/admin/log` shows `delete_message`.
4. Validation: empty and 501-character bodies give 400. 11 rapid posts: the 11th gives 429.
5. Solo spot: 409 `solo_cleanup`.
6. Closed spot: GET works, POST gives 409 `event_closed`; after reopen, POST works again.
7. Expiry: set `cleaned_at` to 25 h ago directly in the DB; GET/POST give 410; running the cleanup query removes the rows.

**Checks before every commit:** `npm run typecheck` (both repos) and `npm run build` (frontend).

**Manual, in the browser** (local DB only): two test users in two windows chat on one spot; delete own; admin deletes from
the Admin screen; cleaned banner shows the countdown; 390 px and 360 px widths; keyboard doesn't cover the composer.

## Delivery
- All work on `ramzi/dev` in both repos. PRs to `main`: **backend first** (the frontend needs the endpoints), then frontend.
- The new table is created automatically when production boots the new backend (`initSchema`). It's additive only, so it's
  safe for the existing data.
