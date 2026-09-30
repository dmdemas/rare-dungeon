export type PerkSide = 'friend' | 'dungeon'

/** Active rank only; I=1, II=2, III=3. */
export type PerkRank = 1 | 2 | 3

export type FriendPerkId =
  | 'fearless'
  | 'dash'
  | 'sharpEye'
  | 'endurance'
  | 'rally'
  | 'dodge'

export type DungeonPerkId =
  | 'dreadfulBeasts'
  | 'sharpClaws'
  | 'fog'
  | 'thickHide'
  | 'walls'
  | 'horde'

export type PerkId = FriendPerkId | DungeonPerkId

export type PerkType =
  | 'Defense'
  | 'Mobility'
  | 'Vision'
  | 'Stamina'
  | 'Recovery'
  | 'Control'
  | 'Offense'
  | 'Map'
  | 'Spawn'

export type PerkDef<T extends PerkId = PerkId> = {
  id: T
  side: PerkSide
  /** English UI name. */
  name: string
  type: PerkType
  /** One short English rule for tooltips. */
  rule: string
  /** Rank labels I / II / III (English UI). */
  ranks: [string, string, string]
  /**
   * Absolute-from-repo path under assets/refs.perk — file must match this name.
   * Never substitute another perk's art.
   */
  iconPath: string
}

/** Three history slots (icons). Empty = null. */
export type PerkSlotHistory<T extends PerkId> = [T | null, T | null, T | null]

/** Rank by perk id — separate from slot history. */
export type PerkRankMap = Partial<Record<PerkId, PerkRank>>

export type PerkOffer<T extends PerkId> = [T, T]

export type SidePerkState<T extends PerkId> = {
  /** Icon history only (order of picks). */
  slots: PerkSlotHistory<T>
  /** Current rank per line. Only this rank applies. */
  ranks: Partial<Record<T, PerkRank>>
}

export type PerksState = {
  friend: SidePerkState<FriendPerkId>
  dungeon: SidePerkState<DungeonPerkId>
}
