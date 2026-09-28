// End-to-end regression suite (spec §11 smoke v1–v5, §12.2).
// Usage: npm run smoke -- <baseUrl>   (default http://localhost:8787)
// Creates fresh @naqiwha.test users every run; remove them later with `npm run db:clean-test`.
// SMOKE_NO_AI=1 runs v1–v3 only, without spending Gemini quota (free tier: 20 requests/day/model).
// Needs the backend .env (DATABASE_URL): photos the AI didn't check are approved directly in the DB, and user A is
// made an admin for the moderation steps (both only ever touch this run's @naqiwha.test data).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type {
  AdminAction, AdminEvent, AdminStats, CheckinResult, CompleteResult, EventDetail, EventPin, HistoryEntry, LeaderboardResponse, Me, PhotoAnalysis,
  ShopItem, Voucher,
} from '../shared/types';
import type { ChatMessage, ChatPage } from '../shared/chat';
import { sql } from '../server/db';

const BASE = (process.argv[2] ?? 'http://localhost:8787').replace(/\/+$/, '');
const TS = Date.now();
const ASSETS = fileURLToPath(new URL('../test-assets/', import.meta.url));
const DEV_CODE = '424242';
const NO_AI = process.env.SMOKE_NO_AI === '1';
const t0 = Date.now();

let passed = 0;
let warnings = 0;
const emails: string[] = [];

class Check extends Error {}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Check(msg);
}
function eq<T>(actual: T, expected: T, what: string) {
  if (actual !== expected) throw new Check(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function step(name: string, fn: () => Promise<void>, t = Date.now()) {
  try {
    await fn();
  } catch (err) {
    const details = err instanceof Check ? err.message : err instanceof Error ? (err.stack ?? err.message) : String(err);
    console.log(`❌ ${name} — ${details}`);
    summary(false);
    process.exit(1);
  }
  passed++;
  console.log(`✅ ${name} (${Date.now() - t}ms)`);
}
/** Marks a test photo as AI-approved, so steps that only need *a* spot don't spend Gemini quota. */
const APPROVED: PhotoAnalysis = {
  isDirty: true, dirtLevel: 3, items: ['plastic bottles'], suggestedTitle: 'Smoke', suggestedDescription: 'Smoke test.',
  accepted: true, rejectReason: null,
};
async function approve(imageId: string) {
  await sql`UPDATE images SET ai_analysis = ${sql.json(APPROVED as unknown as Parameters<typeof sql.json>[0])} WHERE id = ${imageId}`;
}
function warn(name: string, msg: string) {
  warnings++;
  console.log(`⚠️  ${name} — ${msg}`);
}
function summary(ok: boolean) {
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${ok ? '✅ SMOKE PASSED' : '❌ SMOKE FAILED'}: ${passed} steps passed, ${warnings} warnings, ${secs}s against ${BASE}`);
  if (emails.length) console.log(`test users: ${emails.join(', ')}  (clean up with: npm run db:clean-test)`);
}

type Res<T> = { status: number; body: T; headers: Headers };
type ErrBody = { error?: { code?: string; message?: string } };

class Client {
  cookie: string | null = null;
  constructor(public name: string, public email: string) {}

  async req<T = unknown>(method: string, path: string, body?: unknown): Promise<Res<T>> {
    const headers: Record<string, string> = {};
    if (this.cookie) headers.Cookie = this.cookie;
    let payload: FormData | string | undefined;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await fetch(BASE + '/api' + path, { method, headers, body: payload, redirect: 'manual' });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new Check(`${method} ${path} as ${this.name}: network error ${cause?.code ?? ''} ${cause?.message ?? String(err)}`);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  /** Asserts the status and returns the body; on mismatch shows the error payload. */
  async ok<T>(method: string, path: string, body?: unknown, status = 200): Promise<T> {
    const r = await this.req<T>(method, path, body);
    if (r.status !== status) {
      throw new Check(`${method} ${path} as ${this.name}: expected ${status}, got ${r.status} ${short(r.body)}`);
    }
    return r.body;
  }

  /** Asserts an error response with the given status (and code, if given). */
  async fails(method: string, path: string, body: unknown, status: number, code?: string) {
    const r = await this.req<ErrBody>(method, path, body);
    if (r.status !== status || (code && r.body?.error?.code !== code)) {
      throw new Check(`${method} ${path} as ${this.name}: expected ${status} ${code ?? ''}, got ${r.status} ${short(r.body)}`);
    }
    return r.body;
  }

  async login() {
    const rc = await this.ok<{ ok: boolean; devLogin?: boolean }>('POST', '/auth/request-code', { email: this.email });
    eq(rc.devLogin, true, `request-code devLogin for ${this.email} (is DEV_TOOLS on?)`);
    const r = await this.req<{ user: Me; isNew: boolean }>('POST', '/auth/verify-code', { email: this.email, code: DEV_CODE });
    if (r.status !== 200) throw new Check(`verify-code for ${this.email}: ${r.status} ${short(r.body)}`);
    const session = r.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('nq_session='));
    expect(session && session.length > 'nq_session='.length, `no nq_session cookie in set-cookie for ${this.email}`);
    this.cookie = session;
    eq(r.body.user.email, this.email, 'verify-code user.email');
    return r.body;
  }

  me() { return this.ok<Me>('GET', '/me'); }

  async upload(asset: string) {
    const bytes = await readFile(ASSETS + asset + '.png');
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'image/png' }), asset + '.png');
    const r = await this.ok<{ id: string; url: string }>('POST', '/images', fd, 201);
    eq(r.url, `/api/images/${r.id}`, 'upload url');
    return { ...r, size: bytes.length };
  }
}

function short(v: unknown) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 300 ? s.slice(0, 300) + '…' : s;
}
const isAiDown = (r: Res<unknown>) => r.status === 503 && (r.body as ErrBody)?.error?.code === 'ai_unavailable';

async function makeUser(letter: string, first: string, last: string) {
  const c = new Client(letter.toUpperCase(), `smoke-${letter}-${TS}@naqiwha.test`);
  emails.push(c.email);
  const { user, isNew } = await c.login();
  eq(isNew, true, `${c.name} isNew`);
  eq(user.firstName, null, `${c.name} firstName before onboarding`);
  const me = await c.ok<Me>('PATCH', '/me', { firstName: first, lastName: last });
  eq(me.displayName, `${first} ${last[0]}.`, `${c.name} displayName`);
  return c;
}

async function main() {
  console.log(`Naqiwha smoke against ${BASE} (run ${TS})\n`);
  const A = new Client('A', `smoke-a-${TS}@naqiwha.test`);
  emails.push(A.email);
  let B!: Client, C!: Client, D!: Client;
  let meA!: Me, meB!: Me, meC!: Me, meD!: Me;

  // ───────────── v1: boot + auth ─────────────
  await step('v1 health ok', async () => {
    const h = await new Client('anon', '').ok<{ ok: boolean; commit: string; time: string }>('GET', '/health');
    eq(h.ok, true, 'health.ok');
    expect(typeof h.commit === 'string' && h.commit.length > 0, `health.commit missing: ${short(h)}`);
    console.log(`   commit: ${h.commit}`);
  });

  await step('v1 A logs in with dev code (devLogin, cookie, isNew)', async () => {
    const { isNew, user } = await A.login();
    eq(isNew, true, 'isNew');
    eq(user.displayName, 'New hero', 'displayName before onboarding');
  });

  await step('v1 PATCH /me invalid names → 400 invalid_name', async () => {
    await A.fails('PATCH', '/me', { firstName: 'R2D2', lastName: 'Droid' }, 400, 'invalid_name');
    await A.fails('PATCH', '/me', { firstName: '   ', lastName: 'Smoke' }, 400, 'invalid_name');
    await A.fails('PATCH', '/me', { firstName: 'A'.repeat(31), lastName: 'Smoke' }, 400, 'invalid_name');
  });

  await step('v1 PATCH /me names → GET /me "First L.", level 0, 0 XP, 0 coins, 8-char qrCode', async () => {
    await A.ok<Me>('PATCH', '/me', { firstName: 'Amina', lastName: 'Smoke' });
    meA = await A.me();
    eq(meA.displayName, 'Amina S.', 'displayName');
    eq(meA.initials, 'AS', 'initials');
    eq(meA.level, 0, 'level');
    eq(meA.xp, 0, 'xp');
    eq(meA.coins, 0, 'coins');
    expect(/^[A-Z2-9]{8}$/.test(meA.qrCode), `qrCode not 8 chars: ${meA.qrCode}`);
    eq(meA.unseenRewards.length, 0, 'unseenRewards');
  });

  await step('v1 logout → GET /me 401 → log back in', async () => {
    const out = await A.req<{ ok: boolean }>('POST', '/auth/logout');
    eq(out.status, 200, 'logout status');
    const cleared = out.headers.getSetCookie().find(c => c.startsWith('nq_session='));
    expect(cleared && /max-age=0|expires=thu, 01 jan 1970/i.test(cleared), `logout did not clear the cookie: ${cleared}`);
    A.cookie = null;
    await A.fails('GET', '/me', undefined, 401, 'unauthorized');
    await A.login();
    const again = await A.me();
    eq(again.id, meA.id, 'same user after re-login');
    eq(again.displayName, 'Amina S.', 'name kept after re-login');
  });

  await step('v1 users B, C, D log in and onboard', async () => {
    [B, C, D] = await Promise.all([
      makeUser('b', 'Bilal', 'Smoke'), makeUser('c', 'Chahra', 'Smoke'), makeUser('d', 'Dounia', 'Smoke'),
    ]);
    [meB, meC, meD] = await Promise.all([B.me(), C.me(), D.me()]);
  });

  // ───────────── v2: photos, AI pre-fill, create, join ─────────────
  let before1!: { id: string; url: string; size: number };
  await step('v2 upload before1.png → GET image bytes', async () => {
    before1 = await A.upload('before1');
    const res = await fetch(BASE + before1.url);
    eq(res.status, 200, 'GET image status');
    eq(res.headers.get('content-type'), 'image/png', 'content-type');
    const buf = Buffer.from(await res.arrayBuffer());
    eq(buf.length, before1.size, 'image byte length');
    expect(buf.subarray(1, 4).toString() === 'PNG', 'image bytes are not a PNG');
  });

  await step('v2 upload validation (no file 400, bad type 415)', async () => {
    await A.fails('POST', '/images', new FormData(), 400, 'no_file');
    const fd = new FormData();
    fd.append('file', new Blob(['hello'], { type: 'text/plain' }), 'x.txt');
    await A.fails('POST', '/images', fd, 415, 'bad_type');
  });

  let analysis: PhotoAnalysis | null = null;
  if (NO_AI) warn('v2 (AI) analyze-photo', 'skipped (SMOKE_NO_AI=1)');
  else {
    const name = 'v2 (AI) analyze-photo before1 → isDirty true';
    const t = Date.now();
    const r = await A.req<PhotoAnalysis>('POST', '/ai/analyze-photo', { imageId: before1.id });
    if (isAiDown(r)) warn(name, '503 ai_unavailable (Gemini free-tier quota?) — continuing without AI pre-fill');
    else {
      await step(name, async () => {
        eq(r.status, 200, `status ${short(r.body)}`);
        eq(r.body.isDirty, true, 'isDirty');
        eq(r.body.accepted, true, `accepted (reason: ${r.body.rejectReason})`);
        expect([1, 2, 3, 4, 5].includes(r.body.dirtLevel), `dirtLevel ${r.body.dirtLevel}`);
        expect(r.body.suggestedTitle.length > 0, 'empty suggestedTitle');
        analysis = r.body;
        console.log(`   AI: dirtLevel ${r.body.dirtLevel}, "${r.body.suggestedTitle}"`);
      }, t);
    }
  }

  const title = `Smoke spot ${TS}`;
  const spotBody = {
    title,
    description: 'Plastic bottles and bags along the beach path. Smoke test.',
    lat: 36.7538, lng: 3.0588, address: 'Smoke test landmark',
    startsAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    beforeImageId: '',
  };
  let spot!: EventDetail;
  let soloSpot!: EventDetail;
  let chatExpiredSpotId = '';
  const msgs = (id: string) => `/events/${id}/messages`;
  await step('v2 create spot validation (bad time, short title, missing photo) → 400', async () => {
    spotBody.beforeImageId = before1.id;
    const tooLate = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
    const e1 = await A.fails('POST', '/events', { ...spotBody, startsAt: tooLate }, 400, 'invalid_input');
    eq(e1.error?.message, 'Pick a time in the next 30 days.', 'bad time message');
    await A.fails('POST', '/events', { ...spotBody, startsAt: 'tomorrow-ish' }, 400, 'invalid_input');
    const e2 = await A.fails('POST', '/events', { ...spotBody, title: 'ab' }, 400, 'invalid_input');
    eq(e2.error?.message, 'Give the spot a title (3–60 characters).', 'short title message');
    await A.fails('POST', '/events', { ...spotBody, beforeImageId: crypto.randomUUID() }, 404, 'image_not_found');
    const other = await B.upload('before2');
    await A.fails('POST', '/events', { ...spotBody, beforeImageId: other.id }, 404, 'image_not_found');
    const unchecked = await A.upload('before4');
    await A.fails('POST', '/events', { ...spotBody, beforeImageId: unchecked.id }, 400, 'photo_not_checked');
    const rejected: PhotoAnalysis = { ...APPROVED, accepted: false, rejectReason: 'This shows a laptop, not a littered place.' };
    await sql`UPDATE images SET ai_analysis = ${sql.json(rejected as unknown as Parameters<typeof sql.json>[0])} WHERE id = ${unchecked.id}`;
    const e3 = await A.fails('POST', '/events', { ...spotBody, beforeImageId: unchecked.id }, 422, 'photo_rejected');
    eq(e3.error?.message, rejected.rejectReason, 'rejection reason');
  });

  if (!analysis) await approve(before1.id);
  await step('v2 create spot → 201 detail', async () => {
    spot = await A.ok<EventDetail>('POST', '/events', spotBody, 201);
    eq(spot.title, title, 'title');
    eq(spot.status, 'open', 'status');
    eq(spot.participantCount, 1, 'participantCount');
    eq(spot.checkedInCount, 1, 'checkedInCount (organizer)');
    eq(spot.organizer?.id, meA.id, 'organizer');
    eq(spot.beforeImageUrl, before1.url, 'beforeImageUrl');
    eq(spot.thumbUrl, before1.url, 'thumbUrl');
    eq(spot.verifyAttemptsLeft, 5, 'verifyAttemptsLeft');
    eq(spot.viewer?.isOrganizer, true, 'viewer.isOrganizer');
  });

  await step('v2 solo spot (isPublic: false) → B join / A checkin → 409 solo_cleanup', async () => {
    eq(spot.isPublic, true, 'isPublic defaults to true');
    const photo = await A.upload('before3');
    await approve(photo.id);
    const solo = await A.ok<EventDetail>('POST', '/events', { ...spotBody, title: `${title} solo`, startsAt: new Date().toISOString(), beforeImageId: photo.id, isPublic: false }, 201);
    soloSpot = solo;
    eq(solo.isPublic, false, 'solo isPublic');
    eq(solo.showName, false, 'solo showName defaults to false');
    await B.fails('POST', `/events/${solo.id}/join`, undefined, 409, 'solo_cleanup');
    await A.fails('POST', `/events/${solo.id}/checkin`, { code: meB.qrCode }, 409, 'solo_cleanup');
    const seenByB = await B.ok<EventDetail>('GET', `/events/${solo.id}`);
    eq(seenByB.organizer, null, 'anonymous solo organizer hidden from others');
    eq(seenByB.participants.length, 0, 'anonymous solo participants hidden');
    const seenByA = await A.ok<EventDetail>('GET', `/events/${solo.id}`);
    eq(seenByA.organizer?.id, meA.id, 'organizer still sees themselves');
    const named = await A.upload('before3');
    await approve(named.id);
    const shown = await A.ok<EventDetail>('POST', '/events', { ...spotBody, title: `${title} named`, startsAt: new Date().toISOString(), beforeImageId: named.id, isPublic: false, showName: true }, 201);
    eq((await B.ok<EventDetail>('GET', `/events/${shown.id}`)).organizer?.id, meA.id, 'named solo organizer visible');
  });

  await step('v2 admin: non-admin → 403; close hides + freezes, reopen, delete, audit log', async () => {
    await B.fails('GET', '/admin/stats', undefined, 403, 'not_admin');
    await B.fails('POST', `/admin/events/${spot.id}/close`, undefined, 403, 'not_admin');
    await sql`UPDATE users SET is_admin = true WHERE id = ${meA.id}`;
    eq((await A.me()).isAdmin, true, 'A isAdmin');
    const stats = await A.ok<AdminStats>('GET', '/admin/stats');
    expect(stats.users > 0, 'stats.users');
    const photo = await A.upload('before2');
    await approve(photo.id);
    const mod = await A.ok<EventDetail>('POST', '/events', { ...spotBody, title: `${title} moderated`, beforeImageId: photo.id }, 201);
    await A.ok('POST', `/admin/events/${mod.id}/close`);
    const pins = await B.ok<EventPin[]>('GET', '/events');
    expect(!pins.some(p => p.id === mod.id), 'closed spot still in GET /events');
    await B.fails('POST', `/events/${mod.id}/join`, undefined, 409, 'event_closed');
    const closed = await A.ok<AdminEvent[]>('GET', '/admin/events?status=closed');
    expect(closed.some(e => e.id === mod.id), 'closed spot missing from admin list');
    await A.ok('POST', `/admin/events/${mod.id}/reopen`);
    await B.ok('POST', `/events/${mod.id}/join`);
    await A.ok('DELETE', `/admin/events/${mod.id}`);
    await B.fails('GET', `/events/${mod.id}`, undefined, 404, 'not_found');
    await A.fails('POST', `/admin/users/${meA.id}/admin`, { isAdmin: false }, 409, 'cannot_revoke_self');
    const log = await A.ok<AdminAction[]>('GET', '/admin/log');
    expect(log.some(l => l.action === 'delete_event' && l.targetId === mod.id), 'delete_event not in audit log');
  });

  await step('v2 spot appears in GET /events (anonymous)', async () => {
    const pins = await new Client('anon', '').ok<EventPin[]>('GET', '/events');
    const pin = pins.find(p => p.id === spot.id);
    expect(pin, 'spot not in GET /events');
    eq(pin.status, 'open', 'pin.status');
    eq(pin.participantCount, 1, 'pin.participantCount');
    const anonDetail = await new Client('anon', '').ok<EventDetail>('GET', `/events/${spot.id}`);
    eq(anonDetail.viewer, null, 'anonymous viewer');
  });

  await step('v2 B joins → participantCount 2 + viewer.hasJoined', async () => {
    const d = await B.ok<EventDetail>('POST', `/events/${spot.id}/join`);
    eq(d.participantCount, 2, 'participantCount');
    eq(d.viewer?.hasJoined, true, 'viewer.hasJoined');
    eq(d.viewer?.isCheckedIn, false, 'viewer.isCheckedIn');
    eq(d.viewer?.isOrganizer, false, 'viewer.isOrganizer');
    const again = await B.ok<EventDetail>('POST', `/events/${spot.id}/join`);
    eq(again.participantCount, 2, 'join is idempotent');
  });

  await step('v2 B leaves → count 1, then joins again → 2', async () => {
    const left = await B.ok<EventDetail>('DELETE', `/events/${spot.id}/join`);
    eq(left.participantCount, 1, 'participantCount after leave');
    eq(left.viewer?.hasJoined, false, 'viewer.hasJoined after leave');
    const back = await B.ok<EventDetail>('POST', `/events/${spot.id}/join`);
    eq(back.participantCount, 2, 'participantCount after re-join');
    eq(back.viewer?.hasJoined, true, 'viewer.hasJoined after re-join');
  });

  // ───────────── chat ─────────────
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
    await D.ok('POST', `/events/${spot.id}/join`);
    const d = await D.ok<ChatMessage>('POST', msgs(spot.id), { body: 'delete me, mod' }, 201);
    await D.ok('DELETE', `/events/${spot.id}/join`);
    await D.fails('DELETE', `${msgs(spot.id)}/${d.id}`, undefined, 403, 'not_participant');
    await C.fails('DELETE', `${msgs(spot.id)}/${d.id}`, undefined, 403, 'not_participant');
    await sql`UPDATE users SET is_admin = false WHERE id = ${meA.id}`;
    await A.fails('DELETE', `${msgs(spot.id)}/${d.id}`, undefined, 403, 'not_author');
    await sql`UPDATE users SET is_admin = true WHERE id = ${meA.id}`;
    const asA = await A.ok<ChatPage>('GET', msgs(spot.id));
    eq(asA.messages.find(m => m.id === d.id)?.canDelete, true, 'admin canDelete');
    const mod = await A.ok<ChatMessage>('DELETE', `${msgs(spot.id)}/${d.id}`);
    eq(mod.deleted, 'moderator', 'deleted by moderator');
    const log = await A.ok<AdminAction[]>('GET', '/admin/log');
    const entry = log.find(l => l.action === 'delete_message' && l.targetId === spot.id);
    expect(entry, 'delete_message not in audit log');
    expect(!JSON.stringify(entry).includes('delete me, mod'), 'message text leaked into audit log');
    await A.fails('DELETE', `${msgs(spot.id)}/00000000-0000-0000-0000-000000000000`, undefined, 404, 'message_not_found');
  });

  await step('v2 chat: closed spot is read-only; reopen restores posting; expired → 410', async () => {
    const photo = await A.upload('before3');
    await approve(photo.id);
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
    chatExpiredSpotId = s.id;
  });

  await step('v2 organizer leave → 409 organizer_cannot_leave; unknown spot → 404', async () => {
    await A.fails('DELETE', `/events/${spot.id}/join`, undefined, 409, 'organizer_cannot_leave');
    await B.fails('POST', `/events/${crypto.randomUUID()}/join`, undefined, 404, 'not_found');
    await B.fails('GET', '/events/not-a-uuid', undefined, 404, 'not_found');
  });

  // ───────────── v3: QR check-in ─────────────
  const qrOf = (code: string) => `naqiwha:${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();

  await step('v3 A checks B in via "naqiwha:xxxx-xxxx" → alreadyCheckedIn false, in_progress', async () => {
    const r = await A.ok<CheckinResult>('POST', `/events/${spot.id}/checkin`, { code: qrOf(meB.qrCode) });
    eq(r.alreadyCheckedIn, false, 'alreadyCheckedIn');
    eq(r.status, 'in_progress', 'status');
    eq(r.participant.user.id, meB.id, 'participant.user.id');
    eq(r.participant.checkedIn, true, 'participant.checkedIn');
    eq(r.participant.role, 'member', 'participant.role');
    eq(r.checkedInCount, 2, 'checkedInCount');
  });

  await step('v3 check B in again → alreadyCheckedIn true', async () => {
    const r = await A.ok<CheckinResult>('POST', `/events/${spot.id}/checkin`, { code: meB.qrCode });
    eq(r.alreadyCheckedIn, true, 'alreadyCheckedIn');
    eq(r.checkedInCount, 2, 'checkedInCount');
  });

  await step('v3 checked-in B cannot leave → 409 already_checked_in', async () => {
    await B.fails('DELETE', `/events/${spot.id}/join`, undefined, 409, 'already_checked_in');
  });

  await step('v3 own code → 409 self_checkin; unknown code → 404 unknown_code', async () => {
    await A.fails('POST', `/events/${spot.id}/checkin`, { code: `naqiwha:${meA.qrCode}` }, 409, 'self_checkin');
    await A.fails('POST', `/events/${spot.id}/checkin`, { code: 'naqiwha:ZZZZ-ZZZZ-NOPE' }, 404, 'unknown_code');
    await A.fails('POST', `/events/${spot.id}/checkin`, { code: '' }, 404, 'unknown_code');
  });

  await step('v3 B (not organizer) tries a check-in → 403 not_organizer', async () => {
    await B.fails('POST', `/events/${spot.id}/checkin`, { code: meC.qrCode }, 403, 'not_organizer');
  });

  await step('v3 C (never joined) checked in by code → joined + checked in', async () => {
    const r = await A.ok<CheckinResult>('POST', `/events/${spot.id}/checkin`, { code: ` ${meC.qrCode} ` });
    eq(r.alreadyCheckedIn, false, 'alreadyCheckedIn');
    eq(r.checkedInCount, 3, 'checkedInCount');
    const d = await C.ok<EventDetail>('GET', `/events/${spot.id}`);
    eq(d.viewer?.hasJoined, true, 'C viewer.hasJoined');
    eq(d.viewer?.isCheckedIn, true, 'C viewer.isCheckedIn');
    eq(d.participantCount, 3, 'participantCount');
  });

  await step('v3 D joins but is NOT checked in', async () => {
    const d = await D.ok<EventDetail>('POST', `/events/${spot.id}/join`);
    eq(d.participantCount, 4, 'participantCount');
    eq(d.checkedInCount, 3, 'checkedInCount');
    eq(d.status, 'in_progress', 'status');
    eq(d.viewer?.isCheckedIn, false, 'D viewer.isCheckedIn');
  });

  // ───────────── v4: finish, AI verification, rewards ─────────────
  await step('v4 complete guards: non-organizer 403, foreign photo 404', async () => {
    const bPhoto = await B.upload('after1');
    await B.fails('POST', `/events/${spot.id}/complete`, { afterImageId: bPhoto.id }, 403, 'not_organizer');
    await A.fails('POST', `/events/${spot.id}/complete`, { afterImageId: bPhoto.id }, 404, 'image_not_found');
    await A.fails('POST', `/events/${spot.id}/complete`, {}, 400, 'invalid_input');
  });

  if (NO_AI) {
    warn('v4 (AI) complete', 'SMOKE_NO_AI=1 — stopping before the AI verification (v4/v5 not run)');
    summary(true);
    return;
  }

  let done: CompleteResult | null = null;
  {
    const name = 'v4 (AI) complete with before1 as after photo (still dirty) → verified false, 4 attempts left';
    const dirty = await A.upload('before1');
    const t = Date.now();
    const r = await A.req<CompleteResult>('POST', `/events/${spot.id}/complete`, { afterImageId: dirty.id });
    if (isAiDown(r)) warn(name, '503 ai_unavailable (Gemini quota?) — attempt not counted, skipping to the clean attempt');
    else if (r.status === 200 && r.body.verified && r.body.ai.failOpen) {
      warn(name, 'AI unavailable and AI_FAIL_OPEN=true → auto-approved; using this as the completion');
      done = r.body;
    } else {
      await step(name, async () => {
        eq(r.status, 200, `status ${short(r.body)}`);
        eq(r.body.verified, false, `verified (AI said: ${short(r.body.ai)})`);
        eq(r.body.ai.verdict, 'not_cleaned', 'ai.verdict');
        eq(r.body.rewardedCount, 0, 'rewardedCount');
        eq(r.body.myRewards.length, 0, 'myRewards');
        eq(r.body.event.verifyAttemptsLeft, 4, 'verifyAttemptsLeft');
        eq(r.body.event.status, 'in_progress', 'event.status');
        console.log(`   AI: "${r.body.ai.summary}" issues=${JSON.stringify(r.body.ai.remainingIssues)}`);
      }, t);
    }
  }

  if (!done) {
    const name = 'v4 (AI) complete with after1 → verified true, rewardedCount 3';
    const clean = await A.upload('after1');
    const t = Date.now();
    const r = await A.req<CompleteResult>('POST', `/events/${spot.id}/complete`, { afterImageId: clean.id });
    await step(name, async () => {
      if (isAiDown(r)) throw new Check('Gemini unavailable/quota: 503 ai_unavailable on the clean attempt — cannot verify the core loop');
      eq(r.status, 200, `status ${short(r.body)}`);
      eq(r.body.verified, true, `verified (AI said: ${short(r.body.ai)})`);
      if (r.body.ai.failOpen) warn(name, 'verdict came from AI_FAIL_OPEN, not Gemini');
      eq(r.body.rewardedCount, 3, 'rewardedCount');
      eq(r.body.event.status, 'cleaned', 'event.status');
      eq(r.body.event.afterImageUrl, clean.url, 'event.afterImageUrl');
      eq(r.body.event.thumbUrl, clean.url, 'event.thumbUrl');
      console.log(`   AI: "${r.body.ai.summary}" (before ${r.body.ai.beforeScore} → after ${r.body.ai.afterScore})`);
      done = r.body;
    }, t);
  }
  const result = done!;

  await step('v4 complete result myRewards: cleanup +150/+150 and level_up +100 → level 1', async () => {
    const cleanup = result.myRewards.find(x => x.kind === 'cleanup');
    const lvl = result.myRewards.find(x => x.kind === 'level_up');
    eq(result.myRewards.length, 2, 'myRewards.length');
    expect(cleanup && lvl, `myRewards kinds: ${short(result.myRewards)}`);
    eq(cleanup.xpDelta, 150, 'cleanup.xpDelta');
    eq(cleanup.coinsDelta, 150, 'cleanup.coinsDelta');
    eq(cleanup.eventId, spot.id, 'cleanup.eventId');
    eq(cleanup.eventTitle, title, 'cleanup.eventTitle');
    eq(lvl.coinsDelta, 100, 'level_up.coinsDelta');
    eq(lvl.xpDelta, 0, 'level_up.xpDelta');
    eq(lvl.levelAfter, 1, 'level_up.levelAfter');
  });

  await step('v4 A /me → 150 XP, 250 coins, level 1, rewards already seen', async () => {
    meA = await A.me();
    eq(meA.xp, 150, 'xp');
    eq(meA.coins, 250, 'coins');
    eq(meA.level, 1, 'level');
    eq(meA.unseenRewards.length, 0, 'unseenRewards (organizer rewards are marked seen)');
    eq(meA.stats.cleanups, 1, 'stats.cleanups');
    eq(meA.stats.organized, 1, 'stats.organized');
  });

  for (const [who, client] of [['B', () => B], ['C', () => C]] as const) {
    await step(`v4 ${who} /me → 100 XP, 200 coins, level 1, 2 unseen → POST /rewards/seen → 0`, async () => {
      const c = client();
      const me = await c.me();
      eq(me.xp, 100, 'xp');
      eq(me.coins, 200, 'coins');
      eq(me.level, 1, 'level');
      eq(me.stats.cleanups, 1, 'stats.cleanups');
      eq(me.unseenRewards.length, 2, 'unseenRewards.length');
      const cleanup = me.unseenRewards.find(x => x.kind === 'cleanup');
      const lvl = me.unseenRewards.find(x => x.kind === 'level_up');
      expect(cleanup && lvl, `unseen kinds: ${short(me.unseenRewards)}`);
      eq(cleanup.xpDelta, 100, 'cleanup.xpDelta');
      eq(cleanup.coinsDelta, 100, 'cleanup.coinsDelta');
      eq(lvl.coinsDelta, 100, 'level_up.coinsDelta');
      eq(lvl.levelAfter, 1, 'level_up.levelAfter');
      await c.ok('POST', '/rewards/seen', { ids: me.unseenRewards.map(x => x.id) });
      eq((await c.me()).unseenRewards.length, 0, 'unseenRewards after seen');
    });
  }

  await step('v4 D (joined, never checked in) → 0 XP, 0 coins, level 0', async () => {
    meD = await D.me();
    eq(meD.xp, 0, 'xp');
    eq(meD.coins, 0, 'coins');
    eq(meD.level, 0, 'level');
    eq(meD.unseenRewards.length, 0, 'unseenRewards');
  });

  await step('v4 complete again → 409 already_cleaned; join cleaned spot → 409; check-in → 409', async () => {
    const again = await A.upload('after1');
    await A.fails('POST', `/events/${spot.id}/complete`, { afterImageId: again.id }, 409, 'already_cleaned');
    await D.fails('POST', `/events/${spot.id}/join`, undefined, 409, 'already_cleaned');
    await A.fails('POST', `/events/${spot.id}/checkin`, { code: meD.qrCode }, 409, 'already_cleaned');
  });

  await step('v4 GET /events pin is cleaned with thumbUrl = after image', async () => {
    const pins = await new Client('anon', '').ok<EventPin[]>('GET', '/events');
    const pin = pins.find(p => p.id === spot.id);
    expect(pin, 'cleaned spot missing from GET /events');
    eq(pin.status, 'cleaned', 'pin.status');
    eq(pin.thumbUrl, result.event.afterImageUrl, 'pin.thumbUrl');
    expect(pin.thumbUrl !== before1.url, 'thumbUrl is still the before photo');
  });

  // ───────────── v5: shop, vouchers, history, leaderboard ─────────────
  let vouchers: Voucher[] = [];
  await step('v5 shop items list has the 100-coin espresso', async () => {
    const items = await new Client('anon', '').ok<ShopItem[]>('GET', '/shop/items');
    const sticker = items.find(i => i.id === 'bahdja-espresso');
    expect(sticker, `no bahdja-espresso in ${short(items)}`);
    eq(sticker.cost, 100, 'espresso cost');
    await B.fails('POST', '/shop/purchase', { itemId: 'nope' }, 404, 'unknown_item');
  });

  await step('v5 B buys sticker (200 → 100) → again (→ 0) → third 409 not_enough_coins', async () => {
    const p1 = await B.ok<{ voucher: Voucher; coins: number }>('POST', '/shop/purchase', { itemId: 'bahdja-espresso' }, 201);
    eq(p1.coins, 100, 'coins after first purchase');
    eq(p1.voucher.status, 'active', 'voucher.status');
    expect(/^NQW-[A-Z2-9]{6}$/.test(p1.voucher.code), `voucher code ${p1.voucher.code}`);
    const p2 = await B.ok<{ voucher: Voucher; coins: number }>('POST', '/shop/purchase', { itemId: 'bahdja-espresso' }, 201);
    eq(p2.coins, 0, 'coins after second purchase');
    expect(p1.voucher.code !== p2.voucher.code, 'voucher codes should differ');
    await B.fails('POST', '/shop/purchase', { itemId: 'bahdja-espresso' }, 409, 'not_enough_coins');
    eq((await B.me()).coins, 0, '/me coins');
  });

  await step('v5 GET /vouchers → 2 active; use one → used; again → 409 already_used', async () => {
    vouchers = await B.ok<Voucher[]>('GET', '/vouchers');
    eq(vouchers.length, 2, 'vouchers.length');
    expect(vouchers.every(v => v.status === 'active'), `statuses ${short(vouchers.map(v => v.status))}`);
    const used = await B.ok<Voucher>('POST', `/vouchers/${vouchers[0].id}/use`);
    eq(used.status, 'used', 'status');
    expect(used.usedAt, 'usedAt not set');
    await B.fails('POST', `/vouchers/${vouchers[0].id}/use`, undefined, 409, 'already_used');
    await A.fails('POST', `/vouchers/${vouchers[1].id}/use`, undefined, 404, 'not_found');
    const after = await B.ok<Voucher[]>('GET', '/vouchers');
    eq(after[0].status, 'active', 'active vouchers sort first');
    eq(after[1].status, 'used', 'used voucher sorts last');
  });

  await step('v5 B /me/history → 2 purchases (-100) + cleanup + level_up', async () => {
    const h = await B.ok<HistoryEntry[]>('GET', '/me/history');
    const purchases = h.filter(x => x.kind === 'purchase');
    eq(purchases.length, 2, 'purchase rows');
    expect(purchases.every(p => p.coinsDelta === -100 && p.voucherTitle === 'Espresso on the house'),
      `purchase rows ${short(purchases)}`);
    const cleanup = h.find(x => x.kind === 'cleanup');
    expect(cleanup && cleanup.eventTitle === title && cleanup.xpDelta === 100, `cleanup row ${short(cleanup)}`);
    expect(h.some(x => x.kind === 'level_up' && x.levelAfter === 1), 'no level_up row');
    eq(h.length, 4, 'history length');
  });

  await step('v5 A /me/history → cleanup (+150/+150) + level_up (+100)', async () => {
    const h = await A.ok<HistoryEntry[]>('GET', '/me/history');
    eq(h.length, 2, 'history length');
    expect(h.some(x => x.kind === 'cleanup' && x.xpDelta === 150 && x.coinsDelta === 150), `rows ${short(h)}`);
    expect(h.some(x => x.kind === 'level_up' && x.coinsDelta === 100 && x.levelAfter === 1), `rows ${short(h)}`);
  });

  await step('v5 /me/events: A organized the spot, B joined it', async () => {
    const a = await A.ok<{ organized: EventPin[]; joined: EventPin[] }>('GET', '/me/events');
    expect(a.organized.some(p => p.id === spot.id), 'spot missing from A.organized');
    expect(!a.joined.some(p => p.id === spot.id), 'organizer spot should not be in A.joined');
    const b = await B.ok<{ organized: EventPin[]; joined: EventPin[] }>('GET', '/me/events');
    expect(b.joined.some(p => p.id === spot.id && p.status === 'cleaned'), 'spot missing from B.joined');
    eq(b.organized.length, 0, 'B.organized');
  });

  await step('v5 leaderboard lists A above B; me present for A', async () => {
    const la = await A.ok<LeaderboardResponse>('GET', '/leaderboard');
    const lb = await B.ok<LeaderboardResponse>('GET', '/leaderboard');
    expect(la.me, 'leaderboard.me missing for A');
    expect(lb.me, 'leaderboard.me missing for B');
    eq(la.me.user.id, meA.id, 'me.user.id');
    eq(la.me.user.xp, 150, 'me.user.xp');
    expect(la.me.position < lb.me.position, `A position ${la.me.position} not above B ${lb.me.position}`);
    const ia = la.top.findIndex(e => e.user.id === meA.id);
    const ib = la.top.findIndex(e => e.user.id === meB.id);
    if (ia >= 0 && ib >= 0) expect(ia < ib, `top: A at ${ia} not above B at ${ib}`);
    if (ia >= 0) eq(la.top[ia].position, la.me.position, 'A top position vs me.position');
    for (let i = 1; i < la.top.length; i++) {
      expect(la.top[i - 1].user.xp >= la.top[i].user.xp, 'top is not sorted by xp');
    }
    const anon = await new Client('anon', '').ok<LeaderboardResponse>('GET', '/leaderboard');
    eq(anon.me, null, 'anonymous me');
    console.log(`   A #${la.me.position}, B #${lb.me.position}${ia < 0 ? ' (A outside top 50)' : ''}`);
  });

  summary(true);
  await sql.end();
}

main().catch(err => {
  console.log(`❌ unexpected error — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  summary(false);
  process.exit(1);
});
