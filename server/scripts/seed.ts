import { readFileSync } from 'node:fs';
import { sql } from '../db';
import { newQrCode } from '../services/codes';
import { levelForXp } from '../../shared/ranks';
import type { AiVerdict, EventStatus } from '../../shared/types';

// Demo data for the pitch. Idempotent: users and spots that already exist are skipped.

const USERS = [
  { n: 1, firstName: 'Yacine', lastName: 'Mansouri', xp: 3350, coins: 2150 },
  { n: 2, firstName: 'Amina', lastName: 'Haddad', xp: 1480, coins: 1120 },
  { n: 3, firstName: 'Rayan', lastName: 'Meziane', xp: 1250, coins: 780 },
  { n: 4, firstName: 'Lina', lastName: 'Rahmani', xp: 620, coins: 540 },
  { n: 5, firstName: 'Karim', lastName: 'Saadi', xp: 410, coins: 360 },
  { n: 6, firstName: 'Nesrine', lastName: 'Kaci', xp: 240, coins: 280 },
  { n: 7, firstName: 'Walid', lastName: 'Cherif', xp: 120, coins: 120 },
  { n: 8, firstName: 'Sara', lastName: 'Hamidi', xp: 40, coins: 40 },
];
const email = (n: number) => `seed-${n}@demo.naqiwha`;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const inHours = (h: number) => new Date(Date.now() + h * HOUR);
const jsonb = (v: object) => sql.json(v as Parameters<typeof sql.json>[0]);

type SpotSeed = {
  title: string; description: string; address: string; lat: number; lng: number;
  status: EventStatus; startsAt: Date; organizer: number; members: number[]; checkedIn: number[];
  before: string; after?: string; cleanedAt?: Date; verdict?: AiVerdict;
};

const SPOTS: SpotSeed[] = [
  {
    title: 'Plastic bottles on the beach stairs',
    description: 'The stairs down to the beach are covered in plastic bottles and bags. Bring gloves and a few big bags, we can clear it in an hour.',
    address: 'Stairs down to Plage El Kettani, Bab El Oued',
    lat: 36.7906, lng: 3.0531, status: 'open', startsAt: inHours(26), organizer: 4,
    members: [1, 2, 3, 5, 6, 7, 8], checkedIn: [], before: 'before1',
  },
  {
    title: 'Bags dumped behind the park fence',
    description: 'Someone dumped rubbish bags behind the fence, and they are torn open now. Bring gloves and sturdy bags.',
    address: "Behind the Jardin d'Essai fence, near the Musée des Beaux-Arts",
    lat: 36.7463, lng: 3.0724, status: 'open', startsAt: inHours(50), organizer: 6,
    members: [8], checkedIn: [], before: 'before2',
  },
  {
    title: 'Litter along the seafront promenade',
    description: 'Cans, wrappers and cups all along the promenade railing. Easy one: meet at the kiosk and we sweep towards the port.',
    address: 'Boulevard Che Guevara promenade, opposite the port',
    lat: 36.7772, lng: 3.0614, status: 'in_progress', startsAt: inHours(-0.5), organizer: 2,
    members: [3, 5, 7, 1, 4], checkedIn: [3, 5], before: 'before3',
  },
  {
    title: 'Wrappers and cans around the playground',
    description: 'The grass around the playground is full of snack wrappers and cans. Kids play here, so let’s make it nice again.',
    address: 'Parc de la Liberté, near the playground',
    lat: 36.7625, lng: 3.0497, status: 'open', startsAt: inHours(74), organizer: 7,
    members: [5, 8], checkedIn: [], before: 'before4',
  },
  {
    title: 'Rubbish piled up at the Sablettes parking',
    description: 'Plastic and food packaging piled up at the edge of the parking by the beach. Bring bags and gloves.',
    address: 'Promenade des Sablettes, main parking',
    lat: 36.7422, lng: 3.0806, status: 'cleaned', startsAt: new Date(Date.now() - 3 * DAY), organizer: 1,
    members: [2, 3, 4, 5, 6, 7], checkedIn: [2, 3, 4, 5, 6, 7], before: 'before1', after: 'after1',
    cleanedAt: new Date(Date.now() - 3 * DAY + 2 * HOUR),
    verdict: {
      verdict: 'cleaned', samePlace: true, beforeScore: 8, afterScore: 1, confidence: 0.92,
      summary: 'Huge difference: the parking edge is spotless now. Bravo to the whole team!', remainingIssues: [],
    },
  },
  {
    title: 'Plastic and glass on the Memorial steps',
    description: 'Bottles and broken glass on the steps below the Martyrs’ Memorial. Bring thick gloves for the glass.',
    address: "Steps below Maqam Echahid, Riadh El Feth",
    lat: 36.7457, lng: 3.0697, status: 'cleaned', startsAt: new Date(Date.now() - DAY), organizer: 3,
    members: [1, 8], checkedIn: [1, 8], before: 'before2', after: 'after2',
    cleanedAt: new Date(Date.now() - DAY + 90 * 60 * 1000),
    verdict: {
      verdict: 'cleaned', samePlace: true, beforeScore: 6, afterScore: 1, confidence: 0.88,
      summary: 'The steps look clean again, only a few tiny bits left. Great work!', remainingIssues: [],
    },
  },
];

async function insertImage(name: string, uploaderId: string): Promise<string> {
  const data = readFileSync(new URL(`../../test-assets/${name}.png`, import.meta.url));
  const [row] = await sql`
    INSERT INTO images (uploader_id, mime, bytes, data) VALUES (${uploaderId}, 'image/png', ${data.length}, ${data})
    RETURNING id`;
  return row.id;
}

async function main() {
  let usersCreated = 0;
  for (const u of USERS) {
    const rows = await sql`
      INSERT INTO users (email, first_name, last_name, qr_code, xp, coins, level)
      VALUES (${email(u.n)}, ${u.firstName}, ${u.lastName}, ${newQrCode()}, ${u.xp}, ${u.coins}, ${levelForXp(u.xp)})
      ON CONFLICT (email) DO NOTHING RETURNING id`;
    usersCreated += rows.length;
  }
  const idRows = await sql<{ id: string; email: string }[]>`
    SELECT id, email FROM users WHERE email IN ${sql(USERS.map(u => email(u.n)))}`;
  const userId = (n: number) => idRows.find(r => r.email === email(n))!.id;

  let spotsCreated = 0;
  let participantsCreated = 0;
  for (const s of SPOTS) {
    const organizerId = userId(s.organizer);
    const [exists] = await sql`SELECT 1 FROM events WHERE organizer_id = ${organizerId} AND title = ${s.title}`;
    if (exists) continue;

    const beforeId = await insertImage(s.before, organizerId);
    const afterId = s.after ? await insertImage(s.after, organizerId) : null;
    await sql.begin(async tx => {
      const [ev] = await tx`
        INSERT INTO events (organizer_id, title, description, lat, lng, address, starts_at, status,
                            before_image_id, after_image_id, ai_verdict, verify_attempts, cleaned_at, created_at)
        VALUES (${organizerId}, ${s.title}, ${s.description}, ${s.lat}, ${s.lng}, ${s.address}, ${s.startsAt},
                ${s.status}, ${beforeId}, ${afterId}, ${s.verdict ? jsonb(s.verdict) : null},
                ${s.verdict ? 1 : 0}, ${s.cleanedAt ?? null}, ${new Date(s.startsAt.getTime() - 2 * DAY)})
        RETURNING id`;
      await tx`INSERT INTO participants (event_id, user_id, role, joined_at, checked_in_at)
               VALUES (${ev.id}, ${organizerId}, 'organizer', ${new Date(s.startsAt.getTime() - 2 * DAY)},
                       ${s.status === 'open' ? new Date(s.startsAt.getTime() - 2 * DAY) : s.startsAt})`;
      for (const [i, m] of s.members.entries()) {
        const checkedInAt = s.checkedIn.includes(m) ? new Date(s.startsAt.getTime() + (i + 1) * 60 * 1000) : null;
        await tx`INSERT INTO participants (event_id, user_id, role, joined_at, checked_in_at)
                 VALUES (${ev.id}, ${userId(m)}, 'member', ${new Date(s.startsAt.getTime() - DAY + i * HOUR)}, ${checkedInAt})`;
      }
    });
    spotsCreated++;
    participantsCreated += 1 + s.members.length;
  }

  console.log(`users created: ${usersCreated} (skipped ${USERS.length - usersCreated})`);
  console.log(`spots created: ${spotsCreated} (skipped ${SPOTS.length - spotsCreated})`);
  console.log(`participants created: ${participantsCreated}`);
}

try {
  await main();
} finally {
  await sql.end();
}
