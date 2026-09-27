import { Hono } from 'hono';
import { z } from 'zod';
import { requireUser, type AppEnv } from '../auth';
import { sql } from '../db';
import { env } from '../env';
import { fail, isUuid, parse, readJson } from '../http';
import { getEventDetail, pinColumns, toEventPin, toPublicUser, toRewardEntry } from '../dto';
import { normalizeQr } from '../services/codes';
import { verifyCleanup } from '../services/gemini';
import { completeAndReward } from '../services/rewards';
import type { AiVerdict, CheckinResult, CompleteResult, EventStatus, Participant, PhotoAnalysis } from '../../shared/types';

export const eventRoutes = new Hono<AppEnv>();

const NOT_FOUND = "This spot doesn't exist anymore.";
const ALREADY_CLEANED = 'This spot is already clean — find another one!';
const MAX_VERIFY_ATTEMPTS = 5;
const CLOSED = 'A moderator closed this spot.';
const SOLO = 'This is a solo cleanup — it isn’t open to other heroes.';
const HOUR = 60 * 60 * 1000;
// sql.json, not `${JSON.stringify(x)}::jsonb`: postgres.js serializes jsonb params itself, so a string would be stored as a JSON string.
const jsonb = (v: object) => sql.json(v as Parameters<typeof sql.json>[0]);

const PhotoAnalysisSchema = z.object({
  isDirty: z.boolean(),
  dirtLevel: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  items: z.array(z.string().max(80)).max(10),
  suggestedTitle: z.string().max(200),
  suggestedDescription: z.string().max(1000),
});

const CreateEvent = z.object({
  title: z.string().trim().min(3, 'Give the spot a title (3–60 characters).').max(60, 'Give the spot a title (3–60 characters).'),
  description: z.string().trim()
    .min(3, 'Describe the spot (3–400 characters).').max(400, 'Describe the spot (3–400 characters).'),
  address: z.string().trim().max(120, 'Keep the landmark under 120 characters.').optional().nullable(),
  lat: z.number({ error: 'Pick a location on the map.' }).min(-90, 'Pick a location on the map.').max(90, 'Pick a location on the map.'),
  lng: z.number({ error: 'Pick a location on the map.' }).min(-180, 'Pick a location on the map.').max(180, 'Pick a location on the map.'),
  startsAt: z.string({ error: 'Pick a time in the next 30 days.' }).refine(s => {
    const t = Date.parse(s);
    const now = Date.now();
    return !Number.isNaN(t) && t >= now - 2 * HOUR && t <= now + 30 * 24 * HOUR;
  }, 'Pick a time in the next 30 days.'),
  beforeImageId: z.string({ error: 'Add a photo of the spot.' }).refine(isUuid, 'Add a photo of the spot.'),
  /** Ignored: the server uses the analysis it stored in POST /ai/analyze-photo. Kept so older clients still validate. */
  aiBefore: PhotoAnalysisSchema.optional().nullable(),
  /** false = solo cleanup. Omitted by older clients, which only knew public meetups. */
  isPublic: z.boolean().optional().default(true),
  /** Solo spots only: show the organizer's name. Anonymous by default. */
  showName: z.boolean().optional().default(false),
});

const CheckinBody = z.object({ code: z.string({ error: 'Scan a hero QR code.' }).max(100, 'Scan a hero QR code.') });
const CompleteBody = z.object({
  afterImageId: z.string({ error: 'Take the after photo first.' }).refine(isUuid, 'Take the after photo first.'),
});

type EventCore = {
  id: string; organizerId: string; status: EventStatus; verifyAttempts: number; beforeImageId: string; isPublic: boolean;
  closedAt: Date | null;
};

async function loadEvent(id: string): Promise<EventCore> {
  if (!isUuid(id)) fail(404, 'not_found', NOT_FOUND);
  const [ev] = await sql<EventCore[]>`
    SELECT id, organizer_id, status, verify_attempts, before_image_id, is_public, closed_at FROM events WHERE id = ${id}`;
  if (!ev) fail(404, 'not_found', NOT_FOUND);
  return ev;
}

function assertNotClosed(ev: EventCore) {
  if (ev.closedAt) fail(409, 'event_closed', CLOSED);
}

eventRoutes.get('/events', async c => {
  const rows = await sql`
    SELECT ${pinColumns()} FROM events e
     WHERE e.closed_at IS NULL
       AND (e.status IN ('open','in_progress')
        OR (e.status = 'cleaned' AND e.cleaned_at > now() - interval '30 days'))
     ORDER BY e.created_at DESC LIMIT 500`;
  return c.json(rows.map(r => toEventPin(r as unknown as Parameters<typeof toEventPin>[0])));
});

eventRoutes.post('/events', async c => {
  const me = requireUser(c);
  const body = parse(CreateEvent, await readJson(c));
  const [img] = await sql<{ aiAnalysis: PhotoAnalysis | null }[]>`
    SELECT ai_analysis FROM images WHERE id = ${body.beforeImageId} AND uploader_id = ${me.id}`;
  if (!img) fail(404, 'image_not_found', 'That photo is missing. Take it again.');
  // The AI gate is enforced here, on the server's own copy of the verdict.
  if (!img.aiAnalysis) fail(400, 'photo_not_checked', 'The AI has to check your photo first.');
  if (!img.aiAnalysis.accepted) {
    fail(422, 'photo_rejected', img.aiAnalysis.rejectReason ?? "This photo doesn't show a littered place.");
  }
  const address = body.address ? body.address : null;
  const aiBefore = jsonb(img.aiAnalysis);
  const eventId = await sql.begin(async tx => {
    const [ev] = await tx`
      INSERT INTO events (organizer_id, title, description, lat, lng, address, starts_at, before_image_id, ai_before, is_public, show_name)
      VALUES (${me.id}, ${body.title}, ${body.description}, ${body.lat}, ${body.lng}, ${address},
              ${new Date(body.startsAt)}, ${body.beforeImageId}, ${aiBefore}, ${body.isPublic},
              ${!body.isPublic && body.showName})
      RETURNING id`;
    await tx`INSERT INTO participants (event_id, user_id, role, checked_in_at)
             VALUES (${ev.id}, ${me.id}, 'organizer', now())`;
    return ev.id as string;
  });
  return c.json(await getEventDetail(eventId, me.id), 201);
});

eventRoutes.get('/events/:id', async c => {
  const id = c.req.param('id');
  if (!isUuid(id)) fail(404, 'not_found', NOT_FOUND);
  return c.json(await getEventDetail(id, c.get('user')?.id ?? null));
});

eventRoutes.post('/events/:id/join', async c => {
  const me = requireUser(c);
  const ev = await loadEvent(c.req.param('id'));
  if (ev.status === 'cleaned') fail(409, 'already_cleaned', ALREADY_CLEANED);
  assertNotClosed(ev);
  if (!ev.isPublic && ev.organizerId !== me.id) fail(409, 'solo_cleanup', SOLO);
  await sql`INSERT INTO participants (event_id, user_id, role) VALUES (${ev.id}, ${me.id}, 'member')
            ON CONFLICT (event_id, user_id) DO NOTHING`;
  return c.json(await getEventDetail(ev.id, me.id));
});

eventRoutes.delete('/events/:id/join', async c => {
  const me = requireUser(c);
  const ev = await loadEvent(c.req.param('id'));
  const [p] = await sql`SELECT role, checked_in_at FROM participants WHERE event_id = ${ev.id} AND user_id = ${me.id}`;
  if (p) {
    if (p.role === 'organizer') fail(409, 'organizer_cannot_leave', "Organizers can't leave their own spot.");
    if (p.checkedInAt) fail(409, 'already_checked_in', "You're already checked in — stay and clean!");
    await sql`DELETE FROM participants WHERE event_id = ${ev.id} AND user_id = ${me.id} AND checked_in_at IS NULL`;
  }
  return c.json(await getEventDetail(ev.id, me.id));
});

eventRoutes.post('/events/:id/checkin', async c => {
  const me = requireUser(c);
  const ev = await loadEvent(c.req.param('id'));
  if (ev.organizerId !== me.id) fail(403, 'not_organizer', 'Only the organizer can check people in.');
  if (ev.status === 'cleaned') fail(409, 'already_cleaned', ALREADY_CLEANED);
  assertNotClosed(ev);
  if (!ev.isPublic) fail(409, 'solo_cleanup', SOLO);
  const { code } = parse(CheckinBody, await readJson(c));

  const qr = normalizeQr(code);
  const [hero] = qr ? await sql`SELECT id, first_name, last_name, xp, level FROM users WHERE qr_code = ${qr}` : [];
  if (!hero) fail(404, 'unknown_code', 'No hero with this code.');
  if (hero.id === me.id) fail(409, 'self_checkin', "That's your own code 🙂");

  const [existing] = await sql`
    SELECT role, checked_in_at FROM participants WHERE event_id = ${ev.id} AND user_id = ${hero.id}`;
  const alreadyCheckedIn = !!existing?.checkedInAt;
  let role: Participant['role'] = existing?.role ?? 'member';
  if (!alreadyCheckedIn) {
    const [row] = await sql`
      INSERT INTO participants (event_id, user_id, role, checked_in_at) VALUES (${ev.id}, ${hero.id}, 'member', now())
      ON CONFLICT (event_id, user_id) DO UPDATE SET checked_in_at = COALESCE(participants.checked_in_at, now())
      RETURNING role`;
    role = row.role;
  }
  await sql`UPDATE events SET status = 'in_progress' WHERE id = ${ev.id} AND status = 'open'`;
  const [state] = await sql`
    SELECT e.status,
           (SELECT count(*)::int FROM participants p WHERE p.event_id = e.id AND p.checked_in_at IS NOT NULL) AS checked_in_count
      FROM events e WHERE e.id = ${ev.id}`;

  const result: CheckinResult = {
    participant: { user: toPublicUser(hero as unknown as Parameters<typeof toPublicUser>[0]), role, checkedIn: true },
    alreadyCheckedIn,
    checkedInCount: state.checkedInCount,
    status: state.status,
  };
  return c.json(result);
});

eventRoutes.post('/events/:id/complete', async c => {
  const me = requireUser(c);
  const ev = await loadEvent(c.req.param('id'));
  if (ev.organizerId !== me.id) fail(403, 'not_organizer', 'Only the organizer can finish this cleanup.');
  if (ev.status === 'cleaned') fail(409, 'already_cleaned', ALREADY_CLEANED);
  assertNotClosed(ev);
  if (ev.verifyAttempts >= MAX_VERIFY_ATTEMPTS) {
    fail(429, 'too_many_attempts', 'No verification attempts left for this spot.');
  }
  const { afterImageId } = parse(CompleteBody, await readJson(c));

  const imgs = await sql<{ id: string; uploaderId: string | null; mime: string; data: Buffer }[]>`
    SELECT id, uploader_id, mime, data FROM images WHERE id IN ${sql([ev.beforeImageId, afterImageId])}`;
  const after = imgs.find(i => i.id === afterImageId && i.uploaderId === me.id);
  if (!after) fail(404, 'image_not_found', 'That photo is missing. Take it again.');
  const before = imgs.find(i => i.id === ev.beforeImageId);
  if (!before) fail(404, 'image_not_found', 'The before photo of this spot is missing.');

  let ai: AiVerdict;
  try {
    ai = await verifyCleanup({ buf: before.data, mime: before.mime }, { buf: after.data, mime: after.mime });
  } catch (err) {
    console.error('verifyCleanup failed:', err instanceof Error ? err.message : err);
    if (!env.AI_FAIL_OPEN) fail(503, 'ai_unavailable', 'The AI referee is busy. Try again in a moment.');
    ai = {
      verdict: 'cleaned', samePlace: true, beforeScore: 0, afterScore: 0, confidence: 0,
      summary: 'Verified — AI was unavailable, so we trusted the organizer.', remainingIssues: [], failOpen: true,
    };
  }

  await sql`UPDATE events SET verify_attempts = verify_attempts + 1, ai_verdict = ${jsonb(ai)}
            WHERE id = ${ev.id}`;

  if (ai.verdict !== 'cleaned') {
    const result: CompleteResult = {
      verified: false, ai, event: await getEventDetail(ev.id, me.id), myRewards: [], rewardedCount: 0,
    };
    return c.json(result);
  }

  const rewardedCount = await completeAndReward(ev.id, afterImageId);
  const mine = await sql`
    WITH seen AS (
      UPDATE ledger SET seen_at = COALESCE(seen_at, now())
       WHERE user_id = ${me.id} AND event_id = ${ev.id} AND kind IN ('cleanup','level_up')
      RETURNING *
    )
    SELECT s.*, e.title AS event_title FROM seen s LEFT JOIN events e ON e.id = s.event_id
     ORDER BY s.created_at ASC, s.kind ASC`;
  const result: CompleteResult = {
    verified: true,
    ai,
    event: await getEventDetail(ev.id, me.id),
    myRewards: mine.map(r => toRewardEntry(r as unknown as Parameters<typeof toRewardEntry>[0])),
    rewardedCount,
  };
  return c.json(result);
});
