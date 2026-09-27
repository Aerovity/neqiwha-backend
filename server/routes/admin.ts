import { Hono } from 'hono';
import { z } from 'zod';
import { requireAdmin, type AppEnv } from '../auth';
import { sql } from '../db';
import { displayName, pinColumns, toEventPin, toPublicUser } from '../dto';
import { fail, isUuid, parse, readJson } from '../http';
import type {
  AdminAction, AdminEvent, AdminStats, AdminUser, AiVerdict, PhotoAnalysis,
} from '../../shared/types';

// GET /admin/stats, /admin/events, /admin/users, /admin/log; event close/reopen/delete; grant/revoke admin.
export const adminRoutes = new Hono<AppEnv>();

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const jsonb = (v: object) => sql.json(v as Parameters<typeof sql.json>[0]);

async function logAction(
  adminId: string, action: AdminAction['action'], targetType: AdminAction['targetType'], targetId: string,
  detail: NonNullable<AdminAction['detail']>,
) {
  await sql`INSERT INTO admin_actions (admin_id, action, target_type, target_id, detail)
            VALUES (${adminId}, ${action}, ${targetType}, ${targetId}, ${jsonb(detail)})`;
}

async function loadEvent(id: string) {
  if (!isUuid(id)) fail(404, 'not_found', "This spot doesn't exist anymore.");
  const [ev] = await sql<{ id: string; title: string; closedAt: Date | null }[]>`
    SELECT id, title, closed_at FROM events WHERE id = ${id}`;
  if (!ev) fail(404, 'not_found', "This spot doesn't exist anymore.");
  return ev;
}

adminRoutes.get('/admin/stats', async c => {
  requireAdmin(c);
  const [r] = await sql`
    SELECT
      (SELECT count(*)::int FROM users) AS users,
      (SELECT count(*)::int FROM users WHERE is_admin) AS admins,
      (SELECT count(*)::int FROM events WHERE closed_at IS NULL AND status = 'open') AS open,
      (SELECT count(*)::int FROM events WHERE closed_at IS NULL AND status = 'in_progress') AS in_progress,
      (SELECT count(*)::int FROM events WHERE closed_at IS NULL AND status = 'cleaned') AS cleaned,
      (SELECT count(*)::int FROM events WHERE closed_at IS NOT NULL) AS closed,
      (SELECT count(*)::int FROM events WHERE created_at > date_trunc('day', now())) AS spots_today,
      (SELECT count(*)::int FROM events WHERE cleaned_at > now() - interval '7 days') AS cleanups_this_week`;
  const stats: AdminStats = {
    users: r.users,
    admins: r.admins,
    spots: { open: r.open, inProgress: r.inProgress, cleaned: r.cleaned, closed: r.closed },
    spotsToday: r.spotsToday,
    cleanupsThisWeek: r.cleanupsThisWeek,
  };
  return c.json(stats);
});

const EventFilter = z.enum(['all', 'open', 'in_progress', 'cleaned', 'closed']).catch('all');

adminRoutes.get('/admin/events', async c => {
  requireAdmin(c);
  const status = EventFilter.parse(c.req.query('status'));
  const q = (c.req.query('q') ?? '').trim().slice(0, 80);
  const like = `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
  const rows = await sql`
    SELECT ${pinColumns()}, e.description, e.address, e.created_at, e.closed_at, e.ai_verdict, e.ai_before,
           (SELECT count(*)::int FROM participants p WHERE p.event_id = e.id AND p.checked_in_at IS NOT NULL) AS checked_in_count,
           u.id AS owner_id, u.email AS owner_email, u.first_name AS owner_first_name, u.last_name AS owner_last_name,
           u.xp AS owner_xp, u.level AS owner_level
      FROM events e JOIN users u ON u.id = e.organizer_id
     WHERE ${status === 'all' ? sql`TRUE`
       : status === 'closed' ? sql`e.closed_at IS NOT NULL`
       : sql`e.closed_at IS NULL AND e.status = ${status}`}
       AND (${q === ''} OR e.title ILIKE ${like} OR u.email ILIKE ${like} OR coalesce(e.address, '') ILIKE ${like})
     ORDER BY e.created_at DESC
     LIMIT 100`;
  const events: AdminEvent[] = rows.map(r => ({
    ...toEventPin(r as unknown as Parameters<typeof toEventPin>[0]),
    description: r.description,
    address: r.address,
    organizer: {
      ...toPublicUser({ id: r.ownerId, firstName: r.ownerFirstName, lastName: r.ownerLastName, xp: r.ownerXp, level: r.ownerLevel }),
      email: r.ownerEmail,
    },
    createdAt: iso(r.createdAt)!,
    closedAt: iso(r.closedAt),
    checkedInCount: r.checkedInCount,
    ai: (r.aiVerdict as AiVerdict | null) ?? null,
    aiBefore: (r.aiBefore as PhotoAnalysis | null) ?? null,
  }));
  return c.json(events);
});

adminRoutes.post('/admin/events/:id/close', async c => {
  const admin = requireAdmin(c);
  const ev = await loadEvent(c.req.param('id'));
  if (ev.closedAt) fail(409, 'already_closed', 'This spot is already closed.');
  await sql`UPDATE events SET closed_at = now(), closed_by = ${admin.id} WHERE id = ${ev.id}`;
  await logAction(admin.id, 'close_event', 'event', ev.id, { title: ev.title });
  return c.json({ ok: true });
});

adminRoutes.post('/admin/events/:id/reopen', async c => {
  const admin = requireAdmin(c);
  const ev = await loadEvent(c.req.param('id'));
  if (!ev.closedAt) fail(409, 'not_closed', "This spot isn't closed.");
  await sql`UPDATE events SET closed_at = NULL, closed_by = NULL WHERE id = ${ev.id}`;
  await logAction(admin.id, 'reopen_event', 'event', ev.id, { title: ev.title });
  return c.json({ ok: true });
});

adminRoutes.delete('/admin/events/:id', async c => {
  const admin = requireAdmin(c);
  const ev = await loadEvent(c.req.param('id'));
  // participants cascade; ledger.event_id is SET NULL, so rewards already paid stay in people's history.
  await sql`DELETE FROM events WHERE id = ${ev.id}`;
  await logAction(admin.id, 'delete_event', 'event', ev.id, { title: ev.title });
  return c.json({ ok: true });
});

adminRoutes.get('/admin/users', async c => {
  requireAdmin(c);
  const q = (c.req.query('q') ?? '').trim().slice(0, 80);
  const like = `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
  const rows = await sql`
    SELECT u.id, u.email, u.first_name, u.last_name, u.xp, u.level, u.coins, u.is_admin, u.created_at,
           (SELECT count(*)::int FROM events e WHERE e.organizer_id = u.id) AS spots_organized
      FROM users u
     WHERE ${q === ''} OR u.email ILIKE ${like}
        OR (coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')) ILIKE ${like}
     ORDER BY u.is_admin DESC, u.created_at DESC
     LIMIT 100`;
  const users: AdminUser[] = rows.map(r => ({
    ...toPublicUser(r as unknown as Parameters<typeof toPublicUser>[0]),
    email: r.email,
    coins: r.coins,
    isAdmin: r.isAdmin,
    spotsOrganized: r.spotsOrganized,
    createdAt: iso(r.createdAt)!,
  }));
  return c.json(users);
});

const SetAdminBody = z.object({ isAdmin: z.boolean({ error: 'Say whether this user is an admin.' }) });

adminRoutes.post('/admin/users/:id/admin', async c => {
  const admin = requireAdmin(c);
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'not_found', 'No user with this id.');
  const { isAdmin } = parse(SetAdminBody, await readJson(c));
  if (id === admin.id && !isAdmin) fail(409, 'cannot_revoke_self', "You can't remove your own admin access.");
  const [user] = await sql`UPDATE users SET is_admin = ${isAdmin} WHERE id = ${id} RETURNING email`;
  if (!user) fail(404, 'not_found', 'No user with this id.');
  await logAction(admin.id, isAdmin ? 'grant_admin' : 'revoke_admin', 'user', id, { email: user.email });
  return c.json({ ok: true });
});

adminRoutes.get('/admin/log', async c => {
  requireAdmin(c);
  const rows = await sql`
    SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at,
           u.id AS admin_id, u.email AS admin_email, u.first_name, u.last_name
      FROM admin_actions a LEFT JOIN users u ON u.id = a.admin_id
     ORDER BY a.created_at DESC
     LIMIT 100`;
  const log: AdminAction[] = rows.map(r => ({
    id: r.id,
    admin: r.adminId ? { id: r.adminId, email: r.adminEmail, displayName: displayName(r.firstName, r.lastName) } : null,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    detail: r.detail,
    createdAt: iso(r.createdAt)!,
  }));
  return c.json(log);
});
