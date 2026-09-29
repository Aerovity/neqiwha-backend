import { sql } from '../db';

const HOUR = 60 * 60 * 1000;

/**
 * Permanently deletes chats of spots cleaned or closed more than 24 h ago. Returns the number of messages removed.
 * `eventIds` limits it to those spots (the smoke suite uses this to touch only its own data).
 */
export async function deleteExpiredMessages(eventIds?: string[]): Promise<number> {
  const res = await sql`
    DELETE FROM event_messages m USING events e
     WHERE m.event_id = e.id
       AND COALESCE(e.closed_at, e.cleaned_at) <= now() - interval '24 hours'
       ${eventIds ? sql`AND e.id IN ${sql(eventIds)}` : sql``}`;
  return res.count;
}

/** Runs the cleanup at boot, then hourly. The API already refuses expired chats, so a late or failed run is invisible to users. */
export function startChatCleanup(): void {
  const run = () => deleteExpiredMessages()
    .then(n => { if (n > 0) console.log(`chat cleanup: deleted ${n} messages`); })
    .catch(err => console.error('chat cleanup failed:', err instanceof Error ? err.message : err));
  void run();
  setInterval(run, HOUR).unref();
}
