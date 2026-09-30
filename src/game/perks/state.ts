import { getPerkDef } from './catalog'
import { rollOffer } from './offer'
import type { Rng } from '../rng'
import type {
  DungeonPerkId,
  FriendPerkId,
  PerkId,
  PerkOffer,
  PerkRank,
  PerkSide,
  PerkSlotHistory,
  PerksState,
  SidePerkState,
} from './types'

export const PERK_SLOT_COUNT = 3 as const

export function emptySlots<T extends PerkId>(): PerkSlotHistory<T> {
  return [null, null, null]
}

export function createEmptySideState<T extends PerkId>(): SidePerkState<T> {
  return { slots: emptySlots(), ranks: {} }
}

export function createEmptyPerksState(): PerksState {
  return {
    friend: createEmptySideState<FriendPerkId>(),
    dungeon: createEmptySideState<DungeonPerkId>(),
  }
}

export function nextSlotIndex<T extends PerkId>(slots: PerkSlotHistory<T>): number {
  return slots.findIndex((s) => s === null)
}

/**
 * Roman rank shown on a history slot: 1st pick of a line → I, 2nd → II, 3rd → III.
 * Does not use the live max ranks map (so earlier slots stay I while a later slot shows II).
 */
export function slotDisplayRank<T extends PerkId>(
  slots: PerkSlotHistory<T>,
  index: number,
): PerkRank {
  const id = slots[index]
  if (!id) return 1
  let n = 0
  for (let i = 0; i <= index; i++) {
    if (slots[i] === id) n += 1
  }
  return Math.min(3, Math.max(1, n)) as PerkRank
}

export function currentRank<T extends PerkId>(
  ranks: Partial<Record<T, PerkRank>>,
  id: T,
): PerkRank | 0 {
  return ranks[id] ?? 0
}

/** Rank the pick would become if chosen now. Null if already III. */
export function nextRankAfterPick<T extends PerkId>(
  ranks: Partial<Record<T, PerkRank>>,
  id: T,
): PerkRank | null {
  const cur = currentRank(ranks, id)
  if (cur >= 3) return null
  return (cur + 1) as PerkRank
}

export function sideState(state: PerksState, side: PerkSide): SidePerkState<PerkId> {
  return side === 'friend' ? state.friend : state.dungeon
}

/**
 * Record a pick: append id to next empty history slot; bump rank on that line.
 * Does not apply combat/map effects (use apply()).
 */
export function selectPerk<T extends PerkId>(
  side: SidePerkState<T>,
  id: T,
): SidePerkState<T> {
  const rank = nextRankAfterPick(side.ranks, id)
  if (rank === null) {
    return side
  }

  const slot = nextSlotIndex(side.slots)
  const slots = [...side.slots] as PerkSlotHistory<T>
  if (slot >= 0 && slot < PERK_SLOT_COUNT) {
    slots[slot] = id
  }

  return {
    slots,
    ranks: { ...side.ranks, [id]: rank },
  }
}

export function selectFriendPerk(
  state: PerksState,
  id: FriendPerkId,
): PerksState {
  if (getPerkDef(id).side !== 'friend') return state
  return { ...state, friend: selectPerk(state.friend, id) }
}

export function selectDungeonPerk(
  state: PerksState,
  id: DungeonPerkId,
): PerksState {
  if (getPerkDef(id).side !== 'dungeon') return state
  return { ...state, dungeon: selectPerk(state.dungeon, id) }
}

export function rollFriendOffer(
  state: PerksState,
  rng: Rng,
): PerkOffer<FriendPerkId> | null {
  return rollOffer('friend', state.friend.ranks, rng)
}

export function rollDungeonOffer(
  state: PerksState,
  rng: Rng,
  dangerMap = false,
): PerkOffer<DungeonPerkId> | null {
  return rollOffer('dungeon', state.dungeon.ranks, rng, dangerMap)
}

/**
 * Three sequential random dungeon picks for predefined / Play loadouts
 * (same offer rules / upgrade rules as Create).
 * `picks` is reveal order: one entry per creator round.
 */
export type PlannedDungeonLoadout = {
  picks: { id: DungeonPerkId; rank: PerkRank }[]
}

export function rollPredefinedDungeonPerks(rng: Rng, dangerMap = false): PlannedDungeonLoadout {
  let side = createEmptySideState<DungeonPerkId>()
  const picks: PlannedDungeonLoadout['picks'] = []
  for (let i = 0; i < PERK_SLOT_COUNT; i++) {
    const offer = rollOffer('dungeon', side.ranks, rng, dangerMap)
    if (!offer) break
    const pick = offer[Math.floor(rng() * 2)]!
    side = selectPerk(side, pick)
    const rank = side.ranks[pick]
    if (rank) picks.push({ id: pick, rank })
  }
  return { picks }
}

/** Rebuild reveal order from a Create bake (slots may skip nulls). */
export function plannedLoadoutFromRanks(
  slots: [string | null, string | null, string | null],
  ranks: Record<string, 1 | 2 | 3>,
): PlannedDungeonLoadout {
  const picks: PlannedDungeonLoadout['picks'] = []
  for (const id of slots) {
    if (!id) continue
    const rank = ranks[id]
    if (rank) picks.push({ id: id as DungeonPerkId, rank })
  }
  return { picks }
}

/** Eye/Fog demo: Fog upgrades I→II→III across the three floors. */
export function fixedFogDungeonLoadout(): PlannedDungeonLoadout {
  return {
    picks: [
      { id: 'fog', rank: 1 },
      { id: 'fog', rank: 2 },
      { id: 'fog', rank: 3 },
    ],
  }
}

/** Fearless/Dodge demo: Dreadful Beasts I→II→III. */
export function fixedDreadfulDungeonLoadout(): PlannedDungeonLoadout {
  return {
    picks: [
      { id: 'dreadfulBeasts', rank: 1 },
      { id: 'dreadfulBeasts', rank: 2 },
      { id: 'dreadfulBeasts', rank: 3 },
    ],
  }
}

/** Dodge/Claws demo: Sharp Claws I→II→III. */
export function fixedSharpClawsDungeonLoadout(): PlannedDungeonLoadout {
  return {
    picks: [
      { id: 'sharpClaws', rank: 1 },
      { id: 'sharpClaws', rank: 2 },
      { id: 'sharpClaws', rank: 3 },
    ],
  }
}

/** Dodge III demo: Sharp Claws already at III. */
export function fixedSharpClawsMaxLoadout(): PlannedDungeonLoadout {
  return {
    picks: [
      { id: 'sharpClaws', rank: 3 },
      { id: 'sharpClaws', rank: 3 },
      { id: 'sharpClaws', rank: 3 },
    ],
  }
}

/** Dash/Rally demo: Thick Hide I→II→III. */
export function fixedThickHideDungeonLoadout(): PlannedDungeonLoadout {
  return {
    picks: [
      { id: 'thickHide', rank: 1 },
      { id: 'thickHide', rank: 2 },
      { id: 'thickHide', rank: 3 },
    ],
  }
}

/** Eye/Endurance demo: Walls I→II→III. */
export function fixedWallsDungeonLoadout(): PlannedDungeonLoadout {
  return {
    picks: [
      { id: 'walls', rank: 1 },
      { id: 'walls', rank: 2 },
      { id: 'walls', rank: 3 },
    ],
  }
}

/** Fearless/Rally demo: Horde I→II→III. */
export function fixedHordeDungeonLoadout(): PlannedDungeonLoadout {
  return {
    picks: [
      { id: 'horde', rank: 1 },
      { id: 'horde', rank: 2 },
      { id: 'horde', rank: 3 },
    ],
  }
}

/** Reveal the planned dungeon pick into the matching history slot (Play). */
export function revealDungeonPick(
  dungeon: SidePerkState<DungeonPerkId>,
  planned: PlannedDungeonLoadout,
  slotIndex: number,
): SidePerkState<DungeonPerkId> {
  const pick = planned.picks[slotIndex]
  if (!pick || slotIndex < 0 || slotIndex >= PERK_SLOT_COUNT) return dungeon
  const slots = [...dungeon.slots] as PerkSlotHistory<DungeonPerkId>
  slots[slotIndex] = pick.id
  return {
    slots,
    ranks: { ...dungeon.ranks, [pick.id]: pick.rank },
  }
}
