export type Cell = { x: number; y: number }

export type TileKind = 'floor' | 'wall' | 'entrance' | 'exit'

export type Mob = {
  id: number
  x: number
  y: number
  hp: number
  lastDx: number
  lastDy: number
  /** True while Friend is in orthogonal vision (LOS). */
  aggro: boolean
  /** Spawned by Horde perk — drawn grayscale. */
  fromHorde?: boolean
}

export type DungeonMap = {
  /** MAP_W * MAP_H, row-major: index = y * MAP_W + x */
  tiles: TileKind[]
  walls: Set<string>
}

export type DungeonBlueprint = {
  id: string
  name: string
  map: DungeonMap
  /** Spawn templates for each floor start (same geometry MVP). */
  mobSpawns: { x: number; y: number }[]
  isDemo?: boolean
  isGridDemo?: boolean
  /** Pit fade-out style (1–5) for floor-adjacent walls. */
  pitCliffStyle?: 1 | 2 | 3 | 4 | 5
  isOwned?: boolean
  /** Soft (easy) or Hard (heavy) stake product. */
  tier?: 'soft' | 'hard'
  /** Multiplier on dungeon perk combat effects (Soft < 1). */
  dungeonPowerScale?: number
  /**
   * True when BFS path ≥ 18 steps AND walls ≥ 10 at generation time.
   * Triggers corridor-safety rules: Horde/Walls use minimum spawn counts
   * and have reduced offer probability.
   */
  isCorridor?: boolean
  /** Layout seed from generateBlueprint — keys Walls-perk pits so one layout = one pit set. */
  mapSeed?: number
  /** Live bank (raidable pot). */
  bank?: number
  /** Raiders killed while live. */
  wins?: number
  /** Owned dungeon lifecycle (economy stub). */
  status?: 'live' | 'closed'
  /** Closed because a raider cleared it (bank lost), not by owner claim. */
  wiped?: boolean
  /** Owner's close plan: auto-claim once the dungeon reaches this many wins (unset = manual). */
  closeAtWins?: number
  rewardPending?: number
  invested?: number
  withdrawn?: number
  /** Accrued owner-pool share payouts while live. */
  sharesAccrued?: number
  /**
   * Ticket power accumulated by this dungeon (minted each time dungeon wins a raid).
   * Used for week-end pool distribution. Cleared after week-end settlement.
   */
  ticketPower?: number
  /** Creator-chosen dungeon perks (3 slots). */
  dungeonPerks?: {
    slots: [string | null, string | null, string | null]
    ranks: Record<string, 1 | 2 | 3>
  }
  /** Locked Pits-perk cells for this dungeon (rolled once, never re-rolled). */
  perkPitKeys?: string[]
}

export type FriendState = {
  x: number
  y: number
  stamina: number
  attack: number
  vision: number
}

export type Knowledge = {
  /** Cells ever seen. */
  revealed: Set<string>
  /** Known tile kinds for revealed cells. */
  tiles: Map<string, TileKind>
  /** Last known mob positions (id -> cell key); cleared when dead/seen empty. */
  mobs: Map<number, string>
  knowsExit: boolean
  exitCell: Cell | null
}

export type RaidPhase = 'running' | 'floorClear' | 'won' | 'dead' | 'surrendered'

/** Combat/stat modifiers from active perk ranks (synced from UI perk state). */
export type RaidPerkMods = {
  visionBonus: number
  fogPenalty: number
  staminaBonus: number
  fearlessCut: number
  fearlessRank: 0 | 1 | 2 | 3
  eyeFrightCut: number
  dreadBonus: number
  dreadRank: 0 | 1 | 2 | 3
  fogFrightBonus: number
  dodgeChance: number
  dodgeRank: 0 | 1 | 2 | 3
  dashSteps: number
  rallyHeal: number
  rallyFloorCap: number | null
  mobDamageBonus: number
  clawsRank: 0 | 1 | 2 | 3
  mobHpBonus: number
  hideRank: 0 | 1 | 2 | 3
  wallsExtra: number
  wallsExtraUpper: number
  hordeRank: 0 | 1 | 2 | 3
  hordeExtra: number
}

export type RaidState = {
  dungeonId: string
  dungeonName: string
  map: DungeonMap
  floor: number
  friend: FriendState
  mobs: Mob[]
  knowledge: Knowledge
  phase: RaidPhase
  tick: number
  stuckTicks: number
  noProgressTicks: number
  lastProgressDist: number
  recentCells: string[]
  log: string[]
  /** Bumps when Friend takes combat damage (UI flash). */
  hurtFlash: number
  /** Bumps when Friend is hit while Sharp Claws is active (claw slash VFX). */
  clawsFlash: number
  /** Bumps when Friend successfully dodges a hit (UI duck). */
  dodgeFlash: number
  /** Bumps when Rally successfully restores stamina (UI confetti). */
  rallyFlash: number
  /** Cell of the slain mob for the latest Rally flag (UI only). */
  lastRallyCell: Cell | null
  /** Successful scare-flinch hops used this floor (max FRIEND_FLINCH_MAX). */
  flinchCount: number
  /** Mob ids already rolled for flinch this floor (one check per mob per round). */
  flinchCheckedIds: number[]
  /** Per-raid entropy so chance rolls differ across runs / floors. */
  raidSeed: number
  /** Active perk modifiers (Friend + revealed Dungeon). */
  perkMods: RaidPerkMods
  /** Rally procs used this floor. */
  rallyUsedThisFloor: number
  /** Free Dash steps remaining after last hit. */
  dashStepsLeft: number
  /** Extra walls already placed by the Walls perk this raid. */
  wallsPerkPlaced: number
  /** Cell keys of Walls-perk pits (for cracked adjacent floor edges). */
  wallsPerkCells: string[]
  /** Extra mobs already spawned by the Horde perk this raid. */
  hordePerkSpawned: number
  /** Soft/Hard dungeon perk power scale (1 = full). */
  dungeonPowerScale: number
  /**
   * Base max STA this floor before Endurance perk (Hard: 20→… by floor; Soft: BASE_STAMINA).
   * Soft ease (+2) still lives in softEase → perkMods.staminaBonus — not here.
   */
  floorBaseStamina: number
  /** Product tier for economy + soft ease. */
  tier: 'soft' | 'hard'
  /**
   * Corridor-safety flag copied from blueprint at startRaid.
   * BFS path ≥ 18 AND walls ≥ 10 → Horde/Walls use minimum counts + reduced offer weight.
   */
  isCorridor: boolean
  /** Copied from blueprint; absent on legacy blueprints (pits then keyed by dungeonId). */
  mapSeed?: number
  /** Optional override of Soft floor buffs (sims). */
  softEase?: {
    staminaBonus: number
    frightCut: number
    dodgeFloor: number
    dungeonEfficacy?: number
  }
}

export type Screen =
  | { kind: 'menu' }
  | { kind: 'create'; options: DungeonBlueprint[] }
  | { kind: 'play' }
  | { kind: 'myDungeons' }
  | { kind: 'history'; from: 'menu' | 'myDungeons' }
  | { kind: 'raid'; raid: RaidState }
  | {
      kind: 'outcome'
      result: 'won' | 'dead' | 'surrendered'
      dungeonName: string
      floor: number
      payout?: number
      /** What the Friend paid to enter this raid (for × display). */
      entryPaid?: number
      /** Ticket power won on this clear and the player's balance after it. */
      tickets?: number
      ticketBalance?: number
      note?: string
    }
  | {
      kind: 'weekSettled'
      weekNumber: number
      ticketPayout: number
      playerPower: number
      totalPower: number
      burned: number
      rollover: number
    }

export function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

export function parseKey(key: string): Cell {
  const [xs, ys] = key.split(',')
  return { x: Number(xs), y: Number(ys) }
}
