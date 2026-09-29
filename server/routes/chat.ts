import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AppEnv, type UserRow } from '../auth';
import { sql } from '../db';
import { fail, isUuid, readJson } from '../http';
import { toPublicUser } from '../dto';
import { logAction } from './admin';
import type { EventStatus } from '../../shared/types';
import type { ChatMessage, ChatPage, ChatState } from '../../shared/chat';

export const chatRoutes = new Hono<AppEnv>();

const NOT_FOUND = "This spot doesn't exist anymore.";
const SOLO = 'This is a solo cleanup — it isn’t open to other heroes.';
const CLOSED = 'A moderator closed this spot.';
const NOT_PARTICIPANT = 'Join this spot to see its chat.';
const CHAT_CLOSED = 'This chat has closed.';
const INVALID_MESSAGE = 'Write a message (1–500 characters).';
const SLOW_DOWN = 'Slow down a little — try again in a few seconds.';
const NOT_AUTHOR = 'You can only delete your own messages.';
const MESSAGE_NOT_FOUND = "This message doesn't exist anymore.";
const DAY = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 200;
const RATE_LIMIT = 10; // messages per user per event per 30 s
// ISO UTC with microseconds, as produced by nextCursor(); anything else is treated as a first load.
const CURSOR_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const isCursor = (s: string | undefined): s is string => !!s && CURSOR_RE.test(s) && !Number.isNaN(Date.parse(s));

const PostBody = z.object({ body: z.string().trim().min(1).max(500) });

type ChatCtx = {
  eventId: string; title: string; organizerId: string; state: ChatState; closesAt: Date | null;
  isParticipant: boolean; isAdmin: boolean;
};

/** Chat lifetime: open until 24 h after the spot is cleaned or closed by a moderator. */
export function chatWindow(
  ev: { status: EventStatus; cleanedAt: Date | null; closedAt: Date | null }, now = new Date(),
): { state: ChatState; closesAt: Date | null; expired: boolean } {
  const endsAt = ev.closedAt ?? ev.cleanedAt;
  const closesAt = endsAt ? new Date(endsAt.getTime() + DAY) : null;
  const state: ChatState = ev.closedAt ? 'closed' : ev.status === 'cleaned' ? 'cleaned' : 'open';
  return { state, closesAt, expired: !!closesAt && closesAt <= now };
}

async function loadChat(eventId: string, me: UserRow): Promise<ChatCtx> {
  if (!isUuid(eventId)) fail(404, 'not_found', NOT_FOUND);
  const [ev] = await sql<{
    id: string; title: string; organizerId: string; status: EventStatus; isPublic: boolean;
    cleanedAt: Date | null; closedAt: Date | null;
  }[]>`SELECT id, title, organizer_id, status, is_public, cleaned_at, closed_at FROM events WHERE id = ${eventId}`;
  if (!ev) fail(404, 'not_found', NOT_FOUND);
  if (!ev.isPublic) fail(409, 'solo_cleanup', SOLO);
  const [p] = await sql`SELECT 1 FROM participants WHERE event_id = ${ev.id} AND user_id = ${me.id}`;
  const isParticipant = !!p;
  if (!isParticipant && !me.isAdmin) fail(403, 'not_participant', NOT_PARTICIPANT);
  const win = chatWindow(ev);
  if (win.expired) fail(410, 'chat_closed', CHAT_CLOSED);
  return {
    eventId: ev.id, title: ev.title, organizerId: ev.organizerId, state: win.state, closesAt: win.closesAt,
    isParticipant, isAdmin: me.isAdmin,
  };
}

type MessageRow = {
  id: string; userId: string | null; body: string; createdAt: Date; deletedAt: Date | null; deletedByAdmin: boolean;
  firstName: string | null; lastName: string | null; xp: number | null; level: number | null;
};

async function selectMessages(
  ctx: ChatCtx, meId: string, where: 'recent' | { since: string } | { id: string },
): Promise<ChatMessage[]> {
  const filter = where === 'recent' ? sql`TRUE`
    : 'since' in where ? sql`m.updated_at > ${where.since}::timestamptz`
    : sql`m.id = ${where.id}`;
  const rows = await sql<MessageRow[]>`
    SELECT m.id, m.user_id, m.body, m.created_at, m.deleted_at, m.deleted_by_admin,
           u.first_name, u.last_name, u.xp, u.level
      FROM event_messages m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.event_id = ${ctx.eventId} AND ${filter}
     ORDER BY m.created_at DESC, m.id DESC
     ${where === 'recent' ? sql`LIMIT ${RECENT_LIMIT}` : sql``}`;
  return rows.reverse().map(r => {
    const mine = r.userId === meId;
    const deleted = r.deletedAt ? (r.deletedByAdmin ? 'moderator' : 'author') : null;
    return {
      id: r.id,
      author: r.userId
        ? toPublicUser({ id: r.userId, firstName: r.firstName, lastName: r.lastName, xp: r.xp ?? 0, level: r.level ?? 0 })
        : null,
      isOrganizer: r.userId === ctx.organizerId,
      body: r.body,
      createdAt: r.createdAt.toISOString(),
      deleted,
      mine,
      canDelete: !deleted && (ctx.isAdmin || (mine && ctx.isParticipant && ctx.state !== 'closed')),
    };
  });
}

/**
 * The 5 s overlap lives in the cursor, so a quiet chat returns nothing and re-sent rows stop after a poll or two.
 * Formatted explicitly (ISO, UTC, microseconds) so it doesn't depend on the session's DateStyle or TimeZone.
 */
async function nextCursor(): Promise<string> {
  const [row] = await sql<{ c: string }[]>`
    SELECT to_char((clock_timestamp() - interval '5 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS c`;
  return row.c;
}

chatRoutes.get('/events/:id/messages', async c => {
  const me = requireUser(c);
  const ctx = await loadChat(c.req.param('id'), me);
  const since = c.req.query('since');
  const page: ChatPage = {
    messages: await selectMessages(ctx, me.id, isCursor(since) ? { since } : 'recent'),
    cursor: await nextCursor(),
    state: ctx.state,
    canPost: ctx.isParticipant && ctx.state !== 'closed',
    closesAt: ctx.closesAt?.toISOString() ?? null,
  };
  return c.json(page);
});

chatRoutes.post('/events/:id/messages', async c => {
  const me = requireUser(c);
  const ctx = await loadChat(c.req.param('id'), me);
  if (!ctx.isParticipant) fail(403, 'not_participant', NOT_PARTICIPANT);
  if (ctx.state === 'closed') fail(409, 'event_closed', CLOSED);
  const parsed = PostBody.safeParse(await readJson(c));
  if (!parsed.success) fail(400, 'invalid_message', INVALID_MESSAGE);
  // Count and insert under a per-user, per-event lock so parallel requests can't slip past the limit.
  const id = await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`chat:${ctx.eventId}:${me.id}`}))`;
    const [recent] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM event_messages
       WHERE event_id = ${ctx.eventId} AND user_id = ${me.id} AND created_at > clock_timestamp() - interval '30 seconds'`;
    if (recent.n >= RATE_LIMIT) return null;
    const [row] = await tx<{ id: string }[]>`
      INSERT INTO event_messages (event_id, user_id, body, created_at)
      VALUES (${ctx.eventId}, ${me.id}, ${parsed.data.body}, clock_timestamp())
      RETURNING id`;
    return row.id;
  });
  if (!id) fail(429, 'slow_down', SLOW_DOWN);
  const [msg] = await selectMessages(ctx, me.id, { id });
  return c.json(msg, 201);
});

chatRoutes.delete('/events/:id/messages/:messageId', async c => {
  const me = requireUser(c);
  const ctx = await loadChat(c.req.param('id'), me);
  const messageId = c.req.param('messageId');
  if (!isUuid(messageId)) fail(404, 'message_not_found', MESSAGE_NOT_FOUND);
  const [msg] = await sql<{ userId: string | null; deletedAt: Date | null }[]>`
    SELECT user_id, deleted_at FROM event_messages WHERE id = ${messageId} AND event_id = ${ctx.eventId}`;
  if (!msg) fail(404, 'message_not_found', MESSAGE_NOT_FOUND);
  if (!msg.deletedAt) {
    const isAuthor = msg.userId === me.id;
    if (!ctx.isAdmin) {
      if (!isAuthor) fail(403, 'not_author', NOT_AUTHOR);
      if (ctx.state === 'closed') fail(409, 'event_closed', CLOSED);
    }
    // Only the request that actually flips the row logs it, so parallel deletes leave one audit entry.
    const changed = await sql`
      UPDATE event_messages
         SET body = '', deleted_at = now(), updated_at = clock_timestamp(), deleted_by_admin = ${!isAuthor}
       WHERE id = ${messageId} AND deleted_at IS NULL
      RETURNING id`;
    if (changed.length && !isAuthor) await logAction(me.id, 'delete_message', 'event', ctx.eventId, { title: ctx.title });
  }
  const [deleted] = await selectMessages(ctx, me.id, { id: messageId });
  return c.json(deleted);
});
