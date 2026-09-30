/**
 * Headless bot raid: the same combat code as RaidView (startRaid / tickRaid /
 * perk sync), no rendering. Used by calibration, the world snapshot sim and
 * the "simulate raids" button on owned dungeons.
 */
import {
  createEmptyPerksState,
  plannedLoadoutFromRanks,
  revealDungeonPick,
  rollFriendOffer,
  rollPredefinedDungeonPerks,
  selectFriendPerk,
  syncRaidWithPerks,
  type FriendPerkId,
  type PerkOffer,
  type PlannedDungeonLoadout,
} from './perks'
import { advanceFloor, startRaid, tickRaid } from './raid'
import type { Rng } from './rng'
import type { DungeonBlueprint } from './types'

/** Friend perk greedy values (bot picks the higher of the two offered). */
const FRIEND_PICK_VALUE: Partial<Record<FriendPerkId, number>> = {
  dash: 100, fearless: 92, sharpEye: 90, endurance: 85, rally: 84, dodge: 70,
}

/** With rerolls left, the bot rerolls an offer whose best perk is below this value. */
const REROLL_BELOW_VALUE = 92

const MAX_TICKS = 500
const FLOORS = 3

export type HeadlessRaidResult = {
  /** Friend cleared all floors (dungeon wiped). */
  won: boolean
  /** Floor the raid ended on (1–3). */
  floor: number
  /** Friend-offer rerolls actually spent (≤ the budget passed in). */
  rerollsUsed: number
}

const offerValue = (id: FriendPerkId) => FRIEND_PICK_VALUE[id] ?? 0

/** The bot's pick from a Friend offer (also used by Skip in the live raid). */
export function botFriendPick(offer: PerkOffer<FriendPerkId>): FriendPerkId {
  return offerValue(offer[0]) >= offerValue(offer[1]) ? offer[0] : offer[1]
}

/** Creator-baked loadout for owned dungeons, else a fresh random one (Play rule). */
export function dungeonLoadoutFor(bp: DungeonBlueprint, rng: Rng): PlannedDungeonLoadout {
  const baked = bp.dungeonPerks
  if (baked && baked.slots.some(Boolean)) {
    return plannedLoadoutFromRanks(baked.slots, baked.ranks)
  }
  return rollPredefinedDungeonPerks(rng, bp.isCorridor ?? false)
}

/** `friendRerolls` = Friend-offer reroll budget for the whole raid (Hard ladder). */
export function simulateRaid(
  bp: DungeonBlueprint,
  plan: PlannedDungeonLoadout,
  rng: Rng,
  friendRerolls = 0,
): HeadlessRaidResult {
  let perks = createEmptyPerksState()
  let raid = startRaid(bp, 1)
  let rerollsUsed = 0
  for (let floor = 1; floor <= FLOORS; floor++) {
    let offer = rollFriendOffer(perks, rng)
    while (
      offer &&
      rerollsUsed < friendRerolls &&
      Math.max(offerValue(offer[0]), offerValue(offer[1])) < REROLL_BELOW_VALUE
    ) {
      rerollsUsed++
      offer = rollFriendOffer(perks, rng)
    }
    if (offer) perks = selectFriendPerk(perks, botFriendPick(offer))
    perks = { ...perks, dungeon: revealDungeonPick(perks.dungeon, plan, floor - 1) }
    raid = syncRaidWithPerks(raid, perks)

    let ticks = 0
    while (raid.phase === 'running' && ticks++ < MAX_TICKS) raid = tickRaid(raid)
    if (raid.phase === 'won') return { won: true, floor, rerollsUsed }
    if (raid.phase !== 'floorClear') return { won: false, floor, rerollsUsed }
    if (floor >= FLOORS) return { won: true, floor, rerollsUsed }
    raid = advanceFloor(raid, bp)
  }
  return { won: false, floor: FLOORS, rerollsUsed }
}
