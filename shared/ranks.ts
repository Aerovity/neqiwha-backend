import type { RankLevel } from './types';

export interface Rank {
  level: RankLevel;
  name: string;          // exact spelling, shown in UI
  tagline: string;       // short meaning (editable copy)
  minXp: number;
  xpMultiplier: 1 | 2;
  coinMultiplier: 1 | 2;
  levelUpGift: number;   // coins granted once when this rank is reached
  perks: string[];       // UI strings
}

export const RANKS: readonly Rank[] = [
  { level: 0, name: 'Bronze', tagline: 'Every hero starts here.',
    minXp: 0, xpMultiplier: 1, coinMultiplier: 1, levelUpGift: 0,
    perks: ['Create and join cleanups', 'Earn XP and coins'] },
  { level: 1, name: 'Silver', tagline: 'You clean up after the city. Respect.',
    minXp: 100, xpMultiplier: 1, coinMultiplier: 1, levelUpGift: 100,
    perks: ['Leaf badge next to your name', '+100 coins gift'] },
  { level: 2, name: 'Gold', tagline: 'Spotless, and the whole neighbourhood talks about you.',
    minXp: 400, xpMultiplier: 1, coinMultiplier: 1, levelUpGift: 250,
    perks: ['Leafy frame around your avatar', '+250 coins gift'] },
  { level: 3, name: 'Platinum', tagline: 'Algeria’s cleanup superhero.',
    minXp: 1200, xpMultiplier: 1, coinMultiplier: 2, levelUpGift: 500,
    perks: ['Winged avatar frame', 'Your name shines green', '×2 coins on every cleanup', '+500 coins gift'] },
  { level: 4, name: 'Diamond', tagline: 'Legend status. The city is greener thanks to you.',
    minXp: 3000, xpMultiplier: 2, coinMultiplier: 2, levelUpGift: 1000,
    perks: ['Legendary animated frame', 'Green-gold gradient name', '×2 XP and ×2 coins', '+1000 coins gift'] },
];

export const BASE_REWARD = { xp: 100, coins: 100 } as const;      // every checked-in participant
export const ORGANIZER_BONUS = { xp: 50, coins: 50 } as const;    // added for the organizer
export const MAX_LEVEL: RankLevel = 4;

export function levelForXp(xp: number): RankLevel {
  let level: RankLevel = 0;
  for (const r of RANKS) if (xp >= r.minXp) level = r.level;
  return level;
}

export function rankProgress(xp: number) {
  const level = levelForXp(xp);
  const current = RANKS[level];
  const next = level < MAX_LEVEL ? RANKS[level + 1] : null;
  const pct = next ? (xp - current.minXp) / (next.minXp - current.minXp) : 1;
  return { level, current, next, pct: Math.min(1, Math.max(0, pct)), xpToNext: next ? next.minXp - xp : 0 };
}

/** Multipliers come from the rank held BEFORE the reward. Gifts are not multiplied. */
export function computeCleanupReward(input: { level: RankLevel; xp: number; isOrganizer: boolean }) {
  const rank = RANKS[input.level];
  const baseXp = BASE_REWARD.xp + (input.isOrganizer ? ORGANIZER_BONUS.xp : 0);
  const baseCoins = BASE_REWARD.coins + (input.isOrganizer ? ORGANIZER_BONUS.coins : 0);
  const xpGain = baseXp * rank.xpMultiplier;
  const coinGain = baseCoins * rank.coinMultiplier;
  const newXp = input.xp + xpGain;
  const newLevel = levelForXp(newXp);
  const levelUps = RANKS.filter(r => r.level > input.level && r.level <= newLevel)
                        .map(r => ({ level: r.level, gift: r.levelUpGift }));
  return { xpGain, coinGain, newXp, newLevel, levelUps };
}
