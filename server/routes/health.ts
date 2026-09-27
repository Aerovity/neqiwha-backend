import { Hono } from 'hono';
import type { AppEnv } from '../auth';
import { sql } from '../db';
import { buildSha } from '../env';

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get('/health', async c => {
  try {
    await sql`SELECT 1`;
    return c.json({ ok: true, commit: buildSha, time: new Date().toISOString() });
  } catch (err) {
    console.error('health: db failed', err);
    return c.json({ ok: false, commit: buildSha }, 503);
  }
});
