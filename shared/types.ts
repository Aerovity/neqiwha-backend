export type EventStatus = 'open' | 'in_progress' | 'cleaned';
export type RankLevel = 0 | 1 | 2 | 3 | 4;

export interface PublicUser {
  id: string;
  displayName: string;   // "Yacine M." (first name + last initial) or "New hero"
  initials: string;      // "YM"
  level: RankLevel;
  xp: number;
}

export interface Me {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  initials: string;
  level: RankLevel;
  xp: number;
  coins: number;
  qrCode: string;        // "7F3K9Q2M" — display as "7F3K-9Q2M"; QR payload "naqiwha:7F3K9Q2M"
  stats: { cleanups: number; organized: number };
  unseenRewards: RewardEntry[];
  isAdmin: boolean;
}

export interface EventPin {
  id: string;
  title: string;
  lat: number;
  lng: number;
  status: EventStatus;
  participantCount: number;
  startsAt: string;      // ISO
  isPublic: boolean;     // false = solo cleanup: nobody else can join
  showName: boolean;     // solo spots only: true = the organizer chose to show their name
  spottedBy: string | null; // solo spots with showName: the organizer's display name; null otherwise
  thumbUrl: string;      // /api/images/:id (before photo; after photo once cleaned)
}

export interface Participant {
  user: PublicUser;
  role: 'organizer' | 'member';
  checkedIn: boolean;
}

export interface AiVerdict {
  verdict: 'cleaned' | 'not_cleaned';
  samePlace: boolean;
  beforeScore: number;   // 0–10 litter
  afterScore: number;    // 0–10 litter
  confidence: number;    // 0–1
  summary: string;       // one upbeat sentence
  remainingIssues: string[];
  failOpen?: boolean;    // true = AI unavailable, auto-approved (AI_FAIL_OPEN)
}

export interface EventDetail extends EventPin {
  description: string;
  address: string | null;
  createdAt: string;
  cleanedAt: string | null;
  beforeImageUrl: string;
  afterImageUrl: string | null;
  organizer: PublicUser | null;   // null = anonymous solo spot (hidden from everyone but its organizer and admins)
  participants: Participant[];
  checkedInCount: number;
  ai: AiVerdict | null;
  verifyAttemptsLeft: number;
  viewer: { isOrganizer: boolean; hasJoined: boolean; isCheckedIn: boolean } | null; // null = logged out
  closedAt: string | null;      // set = closed by a moderator: hidden from the map, frozen
}

export interface PhotoAnalysis {
  isDirty: boolean;
  dirtLevel: 1 | 2 | 3 | 4 | 5;
  items: string[];
  suggestedTitle: string;
  suggestedDescription: string;
  accepted: boolean;           // false = the AI refused the photo (not a littered place)
  rejectReason: string | null; // plain-English reason when refused
}

export interface RewardEntry {
  id: string;
  kind: 'cleanup' | 'level_up' | 'purchase';
  eventId: string | null;
  eventTitle: string | null;
  xpDelta: number;
  coinsDelta: number;
  levelAfter: RankLevel | null;
  createdAt: string;
}

export interface CompleteResult {
  verified: boolean;
  ai: AiVerdict;
  event: EventDetail;
  myRewards: RewardEntry[];   // organizer's own rewards (already marked seen)
  rewardedCount: number;      // how many checked-in people were rewarded
}

export interface CheckinResult {
  participant: Participant;
  alreadyCheckedIn: boolean;
  checkedInCount: number;
  status: EventStatus;
}

export interface LeaderboardEntry { position: number; user: PublicUser }
export interface LeaderboardResponse { top: LeaderboardEntry[]; me: LeaderboardEntry | null }

export type ShopTone = 'sun' | 'coral' | 'mint' | 'grape' | 'sky' | 'night';
export interface ShopItem {
  id: string; partner: string; title: string; description: string; cost: number;
  emoji: string;   // item art
  tone: ShopTone;  // art tile colour
}

export interface Voucher {
  id: string;
  itemId: string;
  partner: string;
  title: string;
  code: string;          // "NQW-7F3K9Q"
  cost: number;
  status: 'active' | 'used';
  createdAt: string;
  usedAt: string | null;
}

export interface HistoryEntry extends RewardEntry {
  voucherTitle: string | null;
}

export interface AppConfig { mapsApiKey: string; mapId: string; devTools: boolean; samplePhotos: boolean }

export interface ApiErrorBody { error: { code: string; message: string } }

/** Names accepted by GET /api/dev/sample/:name (DEV_TOOLS or DEMO_SAMPLES). */
export const SAMPLE_PHOTOS = ['before1', 'after1', 'before2', 'after2', 'before3', 'after3', 'before4', 'after4'] as const;
export type SamplePhoto = (typeof SAMPLE_PHOTOS)[number];

// ───────────── Admin ─────────────
export interface AdminStats {
  users: number;
  admins: number;
  spots: { open: number; inProgress: number; cleaned: number; closed: number };
  spotsToday: number;
  cleanupsThisWeek: number;
}

export interface AdminEvent extends EventPin {
  description: string;
  address: string | null;
  organizer: PublicUser & { email: string };
  createdAt: string;
  closedAt: string | null;
  checkedInCount: number;
  ai: AiVerdict | null;
  aiBefore: PhotoAnalysis | null;
}

export interface AdminUser extends PublicUser {
  email: string;
  coins: number;
  isAdmin: boolean;
  spotsOrganized: number;
  createdAt: string;
}

export interface AdminAction {
  id: string;
  admin: { id: string; email: string; displayName: string } | null;
  action: 'close_event' | 'reopen_event' | 'delete_event' | 'grant_admin' | 'revoke_admin';
  targetType: 'event' | 'user';
  targetId: string | null;
  detail: { title?: string; email?: string } | null;
  createdAt: string;
}
