import { BASE_STAMINA, BASE_VISION } from '../config'
import type { PerksState } from './types'
import type { FriendPerkId, DungeonPerkId, PerkRank } from './types'

/** Runtime modifiers derived from current perk ranks (only current rank per line). */
export type ActivePerkMods = {
  visionBonus: number
  fogPenalty: number
  staminaBonus: number
  /** Percent points cut from fright (Fearless). */
  fearlessCut: number
  /** Fearless perk rank 0..3 (aura VFX). */
  fearlessRank: 0 | 1 | 2 | 3
  /** Percent points cut from fright (Sharp Eye). */
  eyeFrightCut: number
  /** Percent points added to fright (Dreadful Beasts). */
  dreadBonus: number
  /** Dreadful Beasts perk rank 0..3 (aura VFX). */
  dreadRank: 0 | 1 | 2 | 3
  /** Percent points added to fright (Fog). */
  fogFrightBonus: number
  /** 0..0.75 */
  dodgeChance: number
  /** Dodge perk rank 0..3 (duck VFX). */
  dodgeRank: 0 | 1 | 2 | 3
  dashSteps: number
  rallyHeal: number
  /** null = unlimited; else max rally procs per floor */
  rallyFloorCap: number | null
  mobDamageBonus: number
  /** Sharp Claws perk rank 0..3 (strike VFX). */
  clawsRank: 0 | 1 | 2 | 3
  mobHpBonus: number
  /** Thick Hide perk rank 0..3 (mob visual scale). */
  hideRank: 0 | 1 | 2 | 3
  /** Pits perk: lower-edge extra pit cells for current rank (0 if inactive). */
  wallsExtra: number
  /** Pits perk: upper-edge extra pit cells (= wallsExtra on corridor maps). */
  wallsExtraUpper: number
  /** Horde perk rank 0..3 (spawn count rolled from rank). */
  hordeRank: 0 | 1 | 2 | 3
  /** Horde perk: max extra monsters for current rank (ceiling). */
  hordeExtra: number
}

const ENDURANCE: Record<PerkRank, number> = { 1: 2, 2: 3, 3: 4 }
const EYE: Record<PerkRank, number> = { 1: 1, 2: 2, 3: 3 }
const EYE_FRIGHT: Record<PerkRank, number> = { 1: 15, 2: 30, 3: 45 }
const FEARLESS: Record<PerkRank, number> = { 1: 25, 2: 50, 3: 75 }
const DODGE: Record<PerkRank, number> = { 1: 0.35, 2: 0.55, 3: 0.75 }
/** Shared Dash table (Soft and Hard). */
const DASH: Record<PerkRank, number> = { 1: 2, 2: 3, 3: 4 }
const DREAD: Record<PerkRank, number> = { 1: 25, 2: 50, 3: 75 }
const FOG: Record<PerkRank, number> = { 1: 1, 2: 2, 3: 3 }
const FOG_FRIGHT: Record<PerkRank, number> = { 1: 15, 2: 30, 3: 45 }
const CLAWS: Record<PerkRank, number> = { 1: 1, 2: 2, 3: 2 }
const HIDE: Record<PerkRank, number> = { 1: 1, 2: 2, 3: 3 }
/** Catalog ranges 4–6 / 6–8 / 8–10. */
const WALLS_EXTRA_MIN: Record<PerkRank, number> = { 1: 4, 2: 6, 3: 8 }
const WALLS_EXTRA_MAX: Record<PerkRank, number> = { 1: 6, 2: 8, 3: 10 }
/** Max Horde: I +1 · II 2–3 · III 2–3 */
const HORDE_MAX: Record<PerkRank, number> = { 1: 1, 2: 3, 3: 3 }

/** Ranged perks (Horde II–III, Walls) roll their upper edge this often; corridor maps never do. */
export const PERK_UPPER_EDGE_P = 0.05

/** Rolled Horde spawn count for a rank (deterministic via caller rng). */
export function rollHordeCount(rank: 0 | 1 | 2 | 3, rng: () => number, dangerMap = false): number {
  if (rank <= 0) return 0
  if (rank === 1) return 1
  if (dangerMap) return 2
  return rng() < PERK_UPPER_EDGE_P ? 3 : 2
}

/** Rolled Walls pit target: lower edge, or upper edge with PERK_UPPER_EDGE_P. */
export function rollWallsTarget(mods: ActivePerkMods, rng: () => number): number {
  if (mods.wallsExtraUpper <= mods.wallsExtra) return mods.wallsExtra
  return rng() < PERK_UPPER_EDGE_P ? mods.wallsExtraUpper : mods.wallsExtra
}

function rankOf<T extends string>(
  ranks: Partial<Record<T, PerkRank>>,
  id: T,
): PerkRank | 0 {
  return ranks[id] ?? 0
}

export function emptyPerkMods(): ActivePerkMods {
  return {
    visionBonus: 0,
    fogPenalty: 0,
    staminaBonus: 0,
    fearlessCut: 0,
    fearlessRank: 0,
    eyeFrightCut: 0,
    dreadBonus: 0,
    dreadRank: 0,
    fogFrightBonus: 0,
    dodgeChance: 0,
    dodgeRank: 0,
    dashSteps: 0,
    rallyHeal: 0,
    rallyFloorCap: null,
    mobDamageBonus: 0,
    clawsRank: 0,
    mobHpBonus: 0,
    hideRank: 0,
    wallsExtra: 0,
    wallsExtraUpper: 0,
    hordeRank: 0,
    hordeExtra: 0,
  }
}

export type DerivePerkOpts = {
  dungeonScale?: number
  /** Soft-tier floor buffs so clear rate can hit ~30% with the same perk set. */
  softEase?: {
    staminaBonus: number
    frightCut: number
    dodgeFloor: number
    /** Soft-only mul on dungeonScale (Hard omits). */
    dungeonEfficacy?: number
  }
  /** Corridor-safety flag (BFS path ≥ 18 AND walls ≥ 10): Walls never rolls its upper edge. */
  dangerMap?: boolean
}

export function derivePerkMods(
  perks: PerksState,
  opts: number | DerivePerkOpts = 1,
): ActivePerkMods {
  const dungeonScale = typeof opts === 'number' ? opts : (opts.dungeonScale ?? 1)
  const softEase = typeof opts === 'number' ? undefined : opts.softEase
  const dangerMap = typeof opts === 'number' ? false : (opts.dangerMap ?? false)
  const fr = perks.friend.ranks
  const dr = perks.dungeon.ranks
  const softEff = softEase?.dungeonEfficacy ?? 1
  const s = Math.max(0, Math.min(4.0, dungeonScale * softEff))

  const eye = rankOf(fr, 'sharpEye' as FriendPerkId)
  const end = rankOf(fr, 'endurance' as FriendPerkId)
  const fear = rankOf(fr, 'fearless' as FriendPerkId)
  const dodge = rankOf(fr, 'dodge' as FriendPerkId)
  const dash = rankOf(fr, 'dash' as FriendPerkId)
  const rally = rankOf(fr, 'rally' as FriendPerkId)

  const dread = rankOf(dr, 'dreadfulBeasts' as DungeonPerkId)
  const fog = rankOf(dr, 'fog' as DungeonPerkId)
  const claws = rankOf(dr, 'sharpClaws' as DungeonPerkId)
  const hide = rankOf(dr, 'thickHide' as DungeonPerkId)
  const walls = rankOf(dr, 'walls' as DungeonPerkId)
  const horde = rankOf(dr, 'horde' as DungeonPerkId)

  let rallyHeal = 0
  let rallyFloorCap: number | null = null
  if (rally === 1) {
    rallyHeal = 1
    rallyFloorCap = 2
  } else if (rally === 2) {
    rallyHeal = 2
    rallyFloorCap = 2
  } else if (rally === 3) {
    rallyHeal = 3
    rallyFloorCap = 2
  }

  const scaleInt = (n: number) => Math.max(0, Math.round(n * s))
  const scalePct = (n: number) => Math.max(0, Math.round(n * s))

  const staminaBonus = (end ? ENDURANCE[end] : 0) + (softEase?.staminaBonus ?? 0)
  const fearlessCut = (fear ? FEARLESS[fear] : 0) + (softEase?.frightCut ?? 0)
  const dodgeChance = Math.max(dodge ? DODGE[dodge] : 0, softEase?.dodgeFloor ?? 0)

  return {
    visionBonus: eye ? EYE[eye] : 0,
    fogPenalty: fog ? scaleInt(FOG[fog]) : 0,
    staminaBonus,
    fearlessCut,
    fearlessRank: fear,
    eyeFrightCut: eye ? EYE_FRIGHT[eye] : 0,
    dreadBonus: dread ? scalePct(DREAD[dread]) : 0,
    dreadRank: dread,
    fogFrightBonus: fog ? scalePct(FOG_FRIGHT[fog]) : 0,
    dodgeChance,
    dodgeRank: dodge,
    dashSteps: dash ? DASH[dash] : 0,
    rallyHeal,
    rallyFloorCap,
    mobDamageBonus: claws ? scaleInt(CLAWS[claws]) : 0,
    clawsRank: claws,
    mobHpBonus: hide ? scaleInt(HIDE[hide]) : 0,
    hideRank: hide,
    wallsExtra: walls ? scaleInt(WALLS_EXTRA_MIN[walls]) : 0,
    wallsExtraUpper: walls ? scaleInt(dangerMap ? WALLS_EXTRA_MIN[walls] : WALLS_EXTRA_MAX[walls]) : 0,
    hordeRank: horde,
    hordeExtra: horde ? scaleInt(HORDE_MAX[horde]) : 0,
  }
}

export function friendVision(mods: ActivePerkMods): number {
  return Math.max(1, BASE_VISION + mods.visionBonus - mods.fogPenalty)
}

export function friendMaxStamina(mods: ActivePerkMods, floorBaseStamina = BASE_STAMINA): number {
  return floorBaseStamina + mods.staminaBonus
}

/** Fright / flinch probability 0..0.95 */
export function frightChance(mods: ActivePerkMods): number {
  const pct = Math.max(
    0,
    Math.min(
      95,
      25 + mods.dreadBonus + mods.fogFrightBonus - mods.fearlessCut - mods.eyeFrightCut,
    ),
  )
  return pct / 100
}

/** Snapshot stats for CLI / HUD checks. */
export function snapshotFriendStats(mods: ActivePerkMods) {
  return {
    attack: 1,
    vision: friendVision(mods),
    maxStamina: friendMaxStamina(mods),
    frightChancePct: Math.round(frightChance(mods) * 100),
    dodgeChancePct: Math.round(mods.dodgeChance * 100),
    dashSteps: mods.dashSteps,
    rallyHeal: mods.rallyHeal,
    rallyFloorCap: mods.rallyFloorCap,
  }
}
