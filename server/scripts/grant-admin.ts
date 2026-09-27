import { initSchema, sql } from '../db';
import { newQrCode } from '../services/codes';

// npm run admin:grant -- someone@example.com [--revoke]
// Works before the person has ever logged in: their account is created now, and their first login signs into it.

async function main() {
  const args = process.argv.slice(2);
  const revoke = args.includes('--revoke');
  const email = args.find(a => !a.startsWith('--'))?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: npm run admin:grant -- <email> [--revoke]');
    process.exitCode = 1;
    return;
  }
  await initSchema(); // make sure users.is_admin exists even if the new backend hasn't booted yet
  const [user] = revoke
    ? await sql`UPDATE users SET is_admin = false WHERE email = ${email} RETURNING id, email, is_admin`
    : await sql`
        INSERT INTO users (email, qr_code, is_admin) VALUES (${email}, ${newQrCode()}, true)
        ON CONFLICT (email) DO UPDATE SET is_admin = true
        RETURNING id, email, is_admin`;
  if (!user) {
    console.error(`No user with email ${email}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`${user.email} is ${user.isAdmin ? 'now an admin' : 'no longer an admin'} (user ${user.id}).`);
}

try {
  await main();
} finally {
  await sql.end();
}
