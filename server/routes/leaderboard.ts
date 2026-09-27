import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { sql } from '../db';
import { toPublicUser } from '../dto';
import type { LeaderboardResponse } from '../../shared/types';

export const leaderboardRoutes = new Hono<AppEnv>();

type Row = Parameters<typeof toPublicUser>[0];

leaderboardRoutes.get('/leaderboard', async c => {
  const rows = await sql<Row[]>`
    SELECT id, first_name, last_name, xp, level FROM users
     WHERE first_name IS NOT NULL ORDER BY xp DESC, created_at ASC LIMIT 50`;
  const top = rows.map((r, i) => ({ position: i + 1, user: toPublicUser(r) }));

  let me: LeaderboardResponse['me'] = null;
  const viewer = c.get('user');
  if (viewer?.firstName) {
    const [{ position }] = await sql<{ position: number }[]>`
      SELECT count(*)::int + 1 AS position FROM users u, (SELECT xp, created_at FROM users WHERE id = ${viewer.id}) v
       WHERE u.first_name IS NOT NULL AND (u.xp > v.xp OR (u.xp = v.xp AND u.created_at < v.created_at))`;
    me = { position, user: toPublicUser(viewer) };
  }
  const result: LeaderboardResponse = { top, me };
  return c.json(result);
});
