import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { env } from './env';

export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 15,
  transform: postgres.camel,
  onnotice: () => {},
});

export async function initSchema() {
  const ddl = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await sql.unsafe(ddl);
}
