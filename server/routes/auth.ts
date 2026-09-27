import { Hono, type Context } from 'hono';
import { endSession, startSession, type AppEnv, type UserRow } from '../auth';
import { sql } from '../db';
import { getMe } from '../dto';
import { env } from '../env';
import { EMAIL_RE, fail, readJson } from '../http';
import { hashOtp, newOtp, newQrCode } from '../services/codes';
import { sendLoginCode } from '../services/email';

// Owner: be-core. POST /auth/request-code, POST /auth/verify-code, POST /auth/logout
export const authRoutes = new Hono<AppEnv>();

const DEV_DOMAIN = '@naqiwha.test';
const DEV_CODE = '424242';
const MAX_ATTEMPTS = 5;
const IP_LIMIT = 20;
const HOUR_MS = 60 * 60 * 1000;

function normalizeEmail(raw: unknown): string {
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) fail(400, 'invalid_email', 'Enter a valid email.');
  return email;
}
const isDevEmail = (email: string) => env.DEV_TOOLS && email.endsWith(DEV_DOMAIN);

// Best effort, per process: resets on restart and isn't shared between instances.
const ipHits = new Map<string, number[]>();
function checkIpLimit(c: Context) {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (!ip) return;
  const now = Date.now();
  const hits = (ipHits.get(ip) ?? []).filter(t => now - t < HOUR_MS);
  if (hits.length >= IP_LIMIT) fail(429, 'too_many', 'Too many codes. Try again in an hour.');
  hits.push(now);
  ipHits.set(ip, hits);
  if (ipHits.size > 10_000) for (const [k, v] of ipHits) if (!v.some(t => now - t < HOUR_MS)) ipHits.delete(k);
}

authRoutes.post('/auth/request-code', async c => {
  const body = await readJson(c);
  const email = normalizeEmail(body.email);
  if (isDevEmail(email)) return c.json({ ok: true, devLogin: true });

  const [limits] = await sql`
    SELECT
      count(*)::int AS last_hour,
      coalesce(bool_or(created_at > now() - interval '30 seconds'), false) AS too_soon
      FROM login_codes
     WHERE email = ${email} AND created_at > now() - interval '1 hour'`;
  if (limits.tooSoon) fail(429, 'too_soon', 'Wait a few seconds before asking for a new code.');
  if (limits.lastHour >= 5) fail(429, 'too_many', 'Too many codes. Try again in an hour.');
  checkIpLimit(c);

  const code = newOtp();
  const [row] = await sql`
    INSERT INTO login_codes (email, code_hash, expires_at)
    VALUES (${email}, ${hashOtp(email, code)}, now() + interval '10 minutes')
    RETURNING id`;
  try {
    await sendLoginCode(email, code);
  } catch (err) {
    await sql`DELETE FROM login_codes WHERE id = ${row.id}`;
    console.error('request-code: email failed:', err instanceof Error ? err.message : err);
    fail(502, 'email_failed', "We couldn't send the email. Try again.");
  }
  return c.json({ ok: true });
});

authRoutes.post('/auth/verify-code', async c => {
  const body = await readJson(c);
  const email = normalizeEmail(body.email);
  const code = typeof body.code === 'string' ? body.code.replace(/\s/g, '') : '';
  if (!/^\d{6}$/.test(code)) fail(400, 'invalid_code', 'Enter the 6-digit code from the email.');

  if (!(isDevEmail(email) && code === DEV_CODE)) {
    const [lc] = await sql`
      SELECT id, code_hash, attempts FROM login_codes
       WHERE email = ${email} AND consumed_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`;
    if (!lc) fail(400, 'code_expired', 'This code expired. Ask for a new one.');
    if (lc.attempts >= MAX_ATTEMPTS) fail(429, 'too_many_attempts', 'Too many tries. Ask for a new code.');
    if (lc.codeHash !== hashOtp(email, code)) {
      const [u] = await sql`UPDATE login_codes SET attempts = attempts + 1 WHERE id = ${lc.id} RETURNING attempts`;
      const left = Math.max(0, MAX_ATTEMPTS - u.attempts);
      if (left === 0) fail(429, 'too_many_attempts', 'Too many tries. Ask for a new code.');
      fail(400, 'code_invalid', `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
    }
    const consumed = await sql`
      UPDATE login_codes SET consumed_at = now() WHERE id = ${lc.id} AND consumed_at IS NULL RETURNING id`;
    if (consumed.length === 0) fail(400, 'code_expired', 'This code expired. Ask for a new one.');
  }

  const [user] = await sql<UserRow[]>`
    INSERT INTO users (email, qr_code) VALUES (${email}, ${newQrCode()})
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING *`;
  await startSession(c, user.id);
  return c.json({ user: await getMe(user.id), isNew: user.firstName === null });
});

authRoutes.post('/auth/logout', c => {
  endSession(c);
  return c.json({ ok: true });
});
