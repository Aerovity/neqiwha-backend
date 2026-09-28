import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AppEnv, type UserRow } from '../auth';
import { sql } from '../db';
import { fail, isUuid, readJson } from '../http';
import { toPublicUser } from '../dto';
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
const DAY = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 200;
const RATE_LIMIT = 10; // messages per user per event per 30 s

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

/** The 5 s overlap lives in the cursor, so a quiet chat returns nothing and re-sent rows stop after a poll or two. */
async function nextCursor(): Promise<string> {
  const [row] = await sql<{ c: string }[]>`SELECT (clock_timestamp() - interval '5 seconds')::text AS c`;
  return row.c;
}

chatRoutes.get('/events/:id/messages', async c => {
  const me = requireUser(c);
  const ctx = await loadChat(c.req.param('id'), me);
  const page: ChatPage = {
    messages: await selectMessages(ctx, me.id, 'recent'),
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
  const [recent] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM event_messages
     WHERE event_id = ${ctx.eventId} AND user_id = ${me.id} AND created_at > now() - interval '30 seconds'`;
  if (recent.n >= RATE_LIMIT) fail(429, 'slow_down', SLOW_DOWN);
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO event_messages (event_id, user_id, body) VALUES (${ctx.eventId}, ${me.id}, ${parsed.data.body})
    RETURNING id`;
  const [msg] = await selectMessages(ctx, me.id, { id: row.id });
  return c.json(msg, 201);
});
