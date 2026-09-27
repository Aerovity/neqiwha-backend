import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AppEnv } from '../auth';
import { sql } from '../db';
import { getMe, pinColumns, toEventPin, toHistoryEntry } from '../dto';
import { fail, isUuid, parse, readJson } from '../http';

// Owner: be-core. GET /me, PATCH /me, GET /me/history, GET /me/events, POST /rewards/seen
export const meRoutes = new Hono<AppEnv>();

const NAME_RE = /^[\p{L}\p{M}' -]+$/u;
function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 1 || name.length > 30 || !NAME_RE.test(name)) {
    fail(400, 'invalid_name', 'Use letters only (1–30 characters).');
  }
  return name;
}

meRoutes.get('/me', async c => c.json(await getMe(requireUser(c).id)));

meRoutes.patch('/me', async c => {
  const me = requireUser(c);
  const body = await readJson(c);
  const firstName = cleanName(body.firstName);
  const lastName = cleanName(body.lastName);
  await sql`UPDATE users SET first_name = ${firstName}, last_name = ${lastName} WHERE id = ${me.id}`;
  return c.json(await getMe(me.id));
});

meRoutes.get('/me/history', async c => {
  const me = requireUser(c);
  const rows = await sql`
    SELECT l.*, e.title AS event_title, v.title AS voucher_title
      FROM ledger l
      LEFT JOIN events e ON e.id = l.event_id
      LEFT JOIN vouchers v ON v.id = l.voucher_id
     WHERE l.user_id = ${me.id}
     ORDER BY l.created_at DESC, l.kind DESC
     LIMIT 50`;
  return c.json(rows.map(r => toHistoryEntry(r as unknown as Parameters<typeof toHistoryEntry>[0])));
});

meRoutes.get('/me/events', async c => {
  const me = requireUser(c);
  const [organized, joined] = await Promise.all([
    sql`SELECT ${pinColumns()} FROM events e
         WHERE e.organizer_id = ${me.id}
         ORDER BY e.created_at DESC LIMIT 30`,
    sql`SELECT ${pinColumns()} FROM events e
          JOIN participants mine ON mine.event_id = e.id
         WHERE mine.user_id = ${me.id} AND mine.role = 'member'
         ORDER BY e.created_at DESC LIMIT 30`,
  ]);
  type PinRow = Parameters<typeof toEventPin>[0];
  return c.json({
    organized: organized.map(r => toEventPin(r as unknown as PinRow)),
    joined: joined.map(r => toEventPin(r as unknown as PinRow)),
  });
});

const SeenBody = z.object({
  ids: z.array(z.string().refine(isUuid, 'Invalid reward id.')).max(50, 'Too many rewards at once.'),
});

meRoutes.post('/rewards/seen', async c => {
  const me = requireUser(c);
  const { ids } = parse(SeenBody, await readJson(c));
  if (ids.length === 0) return c.json({ ok: true });
  await sql`
    UPDATE ledger SET seen_at = now()
     WHERE user_id = ${me.id} AND id IN ${sql(ids)} AND seen_at IS NULL`;
  return c.json({ ok: true });
});
