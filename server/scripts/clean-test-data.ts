import { sql } from '../db';

// Removes automated-test data (@naqiwha.test users). Never touches @demo.naqiwha or real users.

async function main() {
  const [before] = await sql`
    SELECT
      (SELECT count(*)::int FROM events e JOIN users u ON u.id = e.organizer_id
        WHERE u.email LIKE '%@naqiwha.test') AS events,
      (SELECT count(*)::int FROM vouchers v JOIN users u ON u.id = v.user_id
        WHERE u.email LIKE '%@naqiwha.test') AS vouchers`;

  // Admin-log rows written by test admins (smoke's moderation steps) would otherwise stay as "removed admin" entries.
  const actions = await sql`
    DELETE FROM admin_actions WHERE admin_id IN (SELECT id FROM users WHERE email LIKE '%@naqiwha.test') RETURNING id`;
  console.log(`test admin actions deleted: ${actions.length}`);

  // Cascades to their events (and those events' participants), participations, vouchers and ledger rows.
  const users = await sql`DELETE FROM users WHERE email LIKE '%@naqiwha.test' RETURNING id`;

  // Images whose uploader is gone (ON DELETE SET NULL) or that were abandoned over an hour ago.
  // Fresh uploads of real users that are not attached to a spot yet are kept.
  const images = await sql`
    DELETE FROM images i
     WHERE (i.uploader_id IS NULL OR i.created_at < now() - interval '1 hour')
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.before_image_id = i.id OR e.after_image_id = i.id)
    RETURNING id`;

  console.log(`test users deleted: ${users.length}`);
  console.log(`their spots deleted (cascade): ${before.events}`);
  console.log(`their vouchers deleted (cascade): ${before.vouchers}`);
  console.log(`orphan images deleted: ${images.length}`);
}

try {
  await main();
} finally {
  await sql.end();
}
