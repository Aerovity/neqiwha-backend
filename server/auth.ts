import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import { env, isProd } from './env';
import { sql } from './db';
import { fail, isUuid } from './http';

const COOKIE = 'nq_session';
export type UserRow = {
  id: string; email: string; firstName: string | null; lastName: string | null;
  qrCode: string; xp: number; coins: number; level: number; createdAt: Date; isAdmin: boolean;
};
export type AppEnv = { Variables: { user: UserRow | null } };

export async function startSession(c: Context, userId: string) {
  await setSignedCookie(c, COOKIE, userId, env.SESSION_SECRET, {
    httpOnly: true, secure: isProd, sameSite: 'Lax', path: '/', maxAge: 60 * 60 * 24 * 30,
  });
}
export function endSession(c: Context) { deleteCookie(c, COOKIE, { path: '/' }); }

/** Runs on every /api request: sets c.var.user (or null). */
export const loadUser = createMiddleware<AppEnv>(async (c, next) => {
  const id = await getSignedCookie(c, env.SESSION_SECRET, COOKIE);
  let user: UserRow | null = null;
  if (typeof id === 'string' && isUuid(id)) {
    const [row] = await sql<UserRow[]>`SELECT * FROM users WHERE id = ${id}`;
    user = row ?? null;
  }
  c.set('user', user);
  await next();
});

export function requireUser(c: Context<AppEnv>): UserRow {
  const u = c.get('user');
  if (!u) fail(401, 'unauthorized', 'Please log in first.');
  return u;
}

export function requireAdmin(c: Context<AppEnv>): UserRow {
  const u = requireUser(c);
  if (!u.isAdmin) fail(403, 'not_admin', 'Only admins can do this.');
  return u;
}
