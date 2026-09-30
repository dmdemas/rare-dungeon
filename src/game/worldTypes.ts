import type { DungeonTier } from './economy'

/** Dungeons shown per tier in the world; the rest of a snapshot tier is reserve. */
export const LIVE_PER_TIER = 50

/** Real time between two replayed world steps (one AI raid + its consequences). */
export const WORLD_STEP_MS = 30_000

export type SnapDungeon = {
  /** Approved layout seed (generateBlueprint). */
  seed: number
  name: string
  wins: number
  bank: number
  tickets: number
  invested: number
}

export type FeedItem =
  | { kind: 'clear'; tier: DungeonTier; name: string; wins: number; payout: number; paid: number }
  | { kind: 'claim'; tier: DungeonTier; name: string; wins: number; payout: number; invested: number }
  | { kind: 'fail'; tier: DungeonTier; name: string; floor: number; lost: number }
  | { kind: 'wiped'; tier: DungeonTier; name: string; wins: number; lost: number }

export type WorldSnapshot = {
  /** Live dungeons at snapshot time: first LIVE_PER_TIER shown, the rest reserve. */
  soft: SnapDungeon[]
  hard: SnapDungeon[]
  /** rewardPool inflow per replay step, in cents. */
  poolCents: number[]
  /** Net AI ticket power change per replay step. */
  tickets: number[]
  /** Feed items from before the replay window (rotation seed for the panels). */
  history: FeedItem[]
  /** Feed items that surface while the replay window plays. */
  live: { step: number; item: FeedItem }[]
}
