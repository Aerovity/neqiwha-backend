// Environment sanity check. Prints one ✅/⚠️/❌ line per check and never prints values.
// `npm run check:env -- --ai` also runs the real Gemini prompts on test-assets/.
import 'dotenv/config';
import { readFileSync } from 'node:fs';

const withAi = process.argv.includes('--ai');
let failed = false;
const ok = (msg: string) => console.log(`✅ ${msg}`);
const warn = (msg: string) => console.log(`⚠️  ${msg}`);
const bad = (msg: string) => { failed = true; console.log(`❌ ${msg}`); };
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err)).split('\n')[0].slice(0, 200);

async function main() {
  let envMod: typeof import('../env');
  try {
    envMod = await import('../env');
    ok('env parses');
  } catch (err) {
    const issues = (err as { issues?: { path: PropertyKey[] }[] }).issues;
    bad(`env invalid: ${issues ? issues.map(i => i.path.join('.')).join(', ') : errMsg(err)}`);
    return;
  }
  const { env } = envMod;

  const { sql } = await import('../db');
  try {
    await sql`SELECT 1`;
    const tables = await sql<{ tableName: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`;
    const names = tables.map(t => t.tableName);
    const expected = ['users', 'login_codes', 'images', 'events', 'participants', 'vouchers', 'ledger'];
    const missing = expected.filter(t => !names.includes(t));
    ok(`database reachable (SELECT 1); tables: ${names.join(', ') || 'none'}`);
    if (missing.length) warn(`tables missing (created on first server boot): ${missing.join(', ')}`);
  } catch (err) {
    bad(`database: ${errMsg(err)}`);
  }

  const gemini = await import('../services/gemini');
  try {
    const t0 = Date.now();
    const reply = await gemini.pingGemini();
    if (reply.trim().length) ok(`Gemini replies with model ${env.GEMINI_MODEL} (${Date.now() - t0} ms)`);
    else bad(`Gemini (${env.GEMINI_MODEL}) returned an empty reply`);
  } catch (err) {
    bad(`Gemini (${env.GEMINI_MODEL}): ${errMsg(err)}`);
  }

  try {
    const { resend } = await import('../services/email');
    const domain = env.EMAIL_FROM.match(/@([^>\s]+)/)?.[1]?.toLowerCase();
    const { data, error } = await resend.domains.list();
    if (error) {
      warn(`Resend: can't list domains with this key (${error.message}); sending may still work`);
    } else if (domain === 'resend.dev') {
      warn('Resend: EMAIL_FROM uses resend.dev, so emails only reach the Resend account owner');
    } else {
      const d = data?.data.find(x => x.name.toLowerCase() === domain);
      if (d?.status === 'verified') ok('Resend: EMAIL_FROM domain is verified');
      else if (d) bad(`Resend: EMAIL_FROM domain status is "${d.status}"`);
      else bad('Resend: EMAIL_FROM domain is not in this Resend account');
    }
  } catch (err) {
    warn(`Resend: ${errMsg(err)}`);
  }

  if (env.GOOGLE_MAPS_API_KEY) ok('GOOGLE_MAPS_API_KEY present'); else bad('GOOGLE_MAPS_API_KEY missing');
  if (env.GOOGLE_MAPS_MAP_ID) ok(`GOOGLE_MAPS_MAP_ID present${env.GOOGLE_MAPS_MAP_ID === 'DEMO_MAP_ID' ? ' (DEMO_MAP_ID)' : ''}`);
  else bad('GOOGLE_MAPS_MAP_ID missing');
  console.log(`   DEV_TOOLS=${env.DEV_TOOLS} AI_FAIL_OPEN=${env.AI_FAIL_OPEN}`);

  if (withAi) await aiChecks(gemini);
  await sql.end({ timeout: 5 });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// The Gemini key may have a low requests-per-minute quota and the model can be overloaded:
// space calls out and wait out one 429/503.
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  await sleep(4000);
  try {
    return await fn();
  } catch (err) {
    const m = errMsg(err);
    const overloaded = m.includes('503') || m.includes('UNAVAILABLE');
    if (!m.includes('429') && !overloaded) throw err;
    const delay = overloaded ? 10 : Number(String((err as Error).message).match(/retry in ([\d.]+)s/i)?.[1] ?? 30);
    console.log(`   (${overloaded ? 'model overloaded' : 'rate limited'}, waiting ${Math.ceil(delay)} s)`);
    await sleep(Math.min(65, delay + 2) * 1000);
    return fn();
  }
}

async function aiChecks(gemini: typeof import('../services/gemini')) {
  const photo = (name: string) => ({
    buf: readFileSync(new URL(`../../test-assets/${name}.png`, import.meta.url)),
    mime: 'image/png',
  });

  console.log('\n— AI prompts on test-assets —');
  try {
    let t0 = 0;
    const a = await paced(() => { t0 = Date.now(); return gemini.analyzePhoto(photo('before1')); });
    const line = `analyzePhoto(before1): isDirty=${a.isDirty} dirtLevel=${a.dirtLevel} items=[${a.items.join(', ')}] ` +
      `title="${a.suggestedTitle}" (${Date.now() - t0} ms)`;
    if (a.isDirty) ok(line); else bad(`${line} — expected isDirty=true`);
    console.log(`   description: ${a.suggestedDescription}`);
  } catch (err) {
    bad(`analyzePhoto(before1): ${errMsg(err)}`);
  }

  const cases: [string, string, 'cleaned' | 'not_cleaned', string][] = [
    ['before1', 'after1', 'cleaned', 'same place, cleaned'],
    ['before2', 'after2', 'cleaned', 'same place, cleaned'],
    ['before3', 'after3', 'cleaned', 'same place, cleaned'],
    ['before4', 'after4', 'cleaned', 'same place, cleaned'],
    ['before1', 'before1', 'not_cleaned', 'still dirty'],
    ['before1', 'after2', 'not_cleaned', 'different place'],
  ];
  for (const [b, a, expected, why] of cases) {
    try {
      let t0 = 0;
      const v = await paced(() => { t0 = Date.now(); return gemini.verifyCleanup(photo(b), photo(a)); });
      const line = `verifyCleanup(${b}, ${a}): ${v.verdict} (expected ${expected}: ${why}) samePlace=${v.samePlace} ` +
        `scores ${v.beforeScore}→${v.afterScore} conf=${v.confidence} (${Date.now() - t0} ms)`;
      if (v.verdict === expected) ok(line); else bad(line);
      console.log(`   summary: ${v.summary}${v.remainingIssues.length ? ` | remaining: ${v.remainingIssues.join('; ')}` : ''}`);
    } catch (err) {
      bad(`verifyCleanup(${b}, ${a}): ${errMsg(err)}`);
    }
  }
}

await main().catch(err => bad(`unexpected: ${errMsg(err)}`));
console.log(failed ? '\nSome checks failed.' : '\nAll checks passed.');
process.exit(failed ? 1 : 0);
