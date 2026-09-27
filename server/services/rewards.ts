import { sql } from '../db';
import { fail } from '../http';
import { computeCleanupReward } from '../../shared/ranks';
import type { RankLevel } from '../../shared/types';

/** Marks the spot cleaned and pays every checked-in participant, all in one transaction. Returns how many were paid. */
export async function completeAndReward(eventId: string, afterImageId: string): Promise<number> {
  return sql.begin(async tx => {
    const [ev] = await tx`SELECT id, status FROM events WHERE id = ${eventId} FOR UPDATE`;
    if (!ev) fail(404, 'not_found', 'Spot not found.');
    if (ev.status === 'cleaned') fail(409, 'already_cleaned', 'This spot is already clean.');

    await tx`UPDATE events SET status = 'cleaned', cleaned_at = now(), after_image_id = ${afterImageId}
             WHERE id = ${eventId}`;

    const attendees = await tx`
      SELECT u.id, u.xp, u.level, p.role
        FROM participants p JOIN users u ON u.id = p.user_id
       WHERE p.event_id = ${eventId} AND p.checked_in_at IS NOT NULL
         FOR UPDATE OF u`;

    for (const a of attendees) {
      const r = computeCleanupReward({ level: a.level as RankLevel, xp: a.xp, isOrganizer: a.role === 'organizer' });
      const gifts = r.levelUps.reduce((sum, l) => sum + l.gift, 0);
      await tx`UPDATE users SET xp = ${r.newXp}, level = ${r.newLevel}, coins = coins + ${r.coinGain + gifts}
               WHERE id = ${a.id}`;
      await tx`INSERT INTO ledger (user_id, kind, event_id, xp_delta, coins_delta, level_after)
               VALUES (${a.id}, 'cleanup', ${eventId}, ${r.xpGain}, ${r.coinGain}, ${r.newLevel})`;
      for (const lu of r.levelUps) {
        await tx`INSERT INTO ledger (user_id, kind, event_id, xp_delta, coins_delta, level_after)
                 VALUES (${a.id}, 'level_up', ${eventId}, 0, ${lu.gift}, ${lu.level})`;
      }
    }
    return attendees.length;
  });
}
