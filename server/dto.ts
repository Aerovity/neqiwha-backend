import { sql } from './db';
import { fail } from './http';
import type {
  AiVerdict, EventDetail, EventPin, HistoryEntry, Me, Participant, PublicUser, RankLevel, RewardEntry, Voucher,
} from '../shared/types';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
export const imageUrl = (id: string) => `/api/images/${id}`;

export function displayName(first: string | null, last: string | null) {
  if (!first) return 'New hero';
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first;
}
export function initials(first: string | null, last: string | null) {
  if (!first) return 'NH';
  return (first.charAt(0) + (last?.charAt(0) ?? '')).toUpperCase();
}

type UserLike = { id: string; firstName: string | null; lastName: string | null; level: number; xp: number };
export function toPublicUser(row: UserLike): PublicUser {
  return {
    id: row.id,
    displayName: displayName(row.firstName, row.lastName),
    initials: initials(row.firstName, row.lastName),
    level: row.level as RankLevel,
    xp: row.xp,
  };
}

type LedgerRow = {
  id: string; kind: RewardEntry['kind']; eventId: string | null; eventTitle?: string | null;
  xpDelta: number; coinsDelta: number; levelAfter: number | null; createdAt: Date;
};
export function toRewardEntry(row: LedgerRow): RewardEntry {
  return {
    id: row.id,
    kind: row.kind,
    eventId: row.eventId,
    eventTitle: row.eventTitle ?? null,
    xpDelta: row.xpDelta,
    coinsDelta: row.coinsDelta,
    levelAfter: row.levelAfter === null ? null : (row.levelAfter as RankLevel),
    createdAt: iso(row.createdAt)!,
  };
}
export function toHistoryEntry(row: LedgerRow & { voucherTitle?: string | null }): HistoryEntry {
  return { ...toRewardEntry(row), voucherTitle: row.voucherTitle ?? null };
}

export async function getMe(userId: string): Promise<Me> {
  const [u] = await sql`SELECT * FROM users WHERE id = ${userId}`;
  if (!u) fail(401, 'unauthorized', 'Please log in first.');
  const [stats] = await sql`
    SELECT
      (SELECT count(*)::int FROM participants p JOIN events e ON e.id = p.event_id
        WHERE p.user_id = ${userId} AND p.checked_in_at IS NOT NULL AND e.status = 'cleaned') AS cleanups,
      (SELECT count(*)::int FROM events WHERE organizer_id = ${userId}) AS organized`;
  const unseen = await sql<LedgerRow[]>`
    SELECT l.*, e.title AS event_title FROM ledger l LEFT JOIN events e ON e.id = l.event_id
     WHERE l.user_id = ${userId} AND l.seen_at IS NULL AND l.kind IN ('cleanup','level_up')
     ORDER BY l.created_at ASC, l.kind ASC`;
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName,
    lastName: u.lastName,
    displayName: displayName(u.firstName, u.lastName),
    initials: initials(u.firstName, u.lastName),
    level: u.level as RankLevel,
    xp: u.xp,
    coins: u.coins,
    qrCode: u.qrCode,
    stats: { cleanups: stats.cleanups, organized: stats.organized },
    unseenRewards: unseen.map(toRewardEntry),
    isAdmin: u.isAdmin,
  };
}

type EventRow = {
  id: string; title: string; lat: number; lng: number; status: EventPin['status'];
  participantCount: number; startsAt: Date; beforeImageId: string; afterImageId: string | null; isPublic: boolean;
  showName: boolean; orgFirstName: string | null; orgLastName: string | null;
};
export function toEventPin(row: EventRow): EventPin {
  return {
    id: row.id,
    title: row.title,
    lat: row.lat,
    lng: row.lng,
    status: row.status,
    participantCount: row.participantCount,
    startsAt: iso(row.startsAt)!,
    isPublic: row.isPublic,
    showName: row.showName,
    spottedBy: !row.isPublic && row.showName ? displayName(row.orgFirstName, row.orgLastName) : null,
    thumbUrl: imageUrl(row.status === 'cleaned' && row.afterImageId ? row.afterImageId : row.beforeImageId),
  };
}

/** Column list for pin queries; the events table must be aliased `e`: sql`SELECT ${pinColumns()} FROM events e`. */
export const pinColumns = () => sql`
  e.id, e.title, e.lat, e.lng, e.status, e.starts_at, e.before_image_id, e.after_image_id, e.is_public, e.show_name,
  (SELECT u.first_name FROM users u WHERE u.id = e.organizer_id) AS org_first_name,
  (SELECT u.last_name FROM users u WHERE u.id = e.organizer_id) AS org_last_name,
  (SELECT count(*)::int FROM participants p WHERE p.event_id = e.id) AS participant_count`;

export async function getEventDetail(eventId: string, viewerId: string | null): Promise<EventDetail> {
  const [e] = await sql`
    SELECT e.*, (SELECT count(*)::int FROM participants p WHERE p.event_id = e.id) AS participant_count,
           u.first_name AS org_first_name, u.last_name AS org_last_name
      FROM events e JOIN users u ON u.id = e.organizer_id WHERE e.id = ${eventId}`;
  if (!e) fail(404, 'not_found', "This spot doesn't exist anymore.");
  const rows = await sql`
    SELECT p.role, p.checked_in_at, u.id, u.first_name, u.last_name, u.xp, u.level
      FROM participants p JOIN users u ON u.id = p.user_id
     WHERE p.event_id = ${eventId}
     ORDER BY (p.role = 'organizer') DESC, p.checked_in_at NULLS LAST, p.joined_at`;
  const participants: Participant[] = rows.map(r => ({
    user: toPublicUser(r as unknown as UserLike),
    role: r.role,
    checkedIn: r.checkedInAt !== null,
  }));
  const [org] = await sql`SELECT id, first_name, last_name, xp, level FROM users WHERE id = ${e.organizerId}`;
  const mine = viewerId ? rows.find(r => r.id === viewerId) : undefined;
  // Anonymous solo spot: only its organizer and admins may see who reported it.
  let hideIdentity = !e.isPublic && !e.showName && e.organizerId !== viewerId;
  if (hideIdentity && viewerId) {
    const [v] = await sql`SELECT is_admin FROM users WHERE id = ${viewerId}`;
    hideIdentity = !v?.isAdmin;
  }
  return {
    ...toEventPin(e as unknown as EventRow),
    description: e.description,
    address: e.address,
    createdAt: iso(e.createdAt)!,
    cleanedAt: iso(e.cleanedAt),
    beforeImageUrl: imageUrl(e.beforeImageId),
    afterImageUrl: e.afterImageId ? imageUrl(e.afterImageId) : null,
    organizer: hideIdentity ? null : toPublicUser(org as unknown as UserLike),
    participants: hideIdentity ? [] : participants,
    checkedInCount: participants.filter(p => p.checkedIn).length,
    ai: (e.aiVerdict as AiVerdict | null) ?? null,
    verifyAttemptsLeft: Math.max(0, 5 - e.verifyAttempts),
    viewer: viewerId
      ? {
          isOrganizer: e.organizerId === viewerId,
          hasJoined: !!mine,
          isCheckedIn: !!mine && mine.checkedInAt !== null,
        }
      : null,
    closedAt: iso(e.closedAt),
  };
}

type VoucherRow = {
  id: string; itemId: string; partner: string; title: string; code: string; cost: number;
  status: Voucher['status']; createdAt: Date; usedAt: Date | null;
};
export function toVoucher(row: VoucherRow): Voucher {
  return {
    id: row.id,
    itemId: row.itemId,
    partner: row.partner,
    title: row.title,
    code: row.code,
    cost: row.cost,
    status: row.status,
    createdAt: iso(row.createdAt)!,
    usedAt: iso(row.usedAt),
  };
}
