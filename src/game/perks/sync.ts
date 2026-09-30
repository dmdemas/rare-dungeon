import { HARD, SOFT } from '../economy'
import {
  addExtraWalls,
  pickHordeSpawnCells,
  rebuildWallSet,
  relocateOffPits,
  stampPerkPits,
} from '../mapGen'
import { mulberry32 } from '../rng'
import type { Mob, RaidState } from '../types'
import { cellKey } from '../types'
import {
  derivePerkMods,
  emptyPerkMods,
  friendMaxStamina,
  friendVision,
  rollHordeCount,
  rollWallsTarget,
  type ActivePerkMods,
} from './effects'
import type { PerksState } from './types'

function dungeonHash(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Apply Pits / Horde structure bumps when perk targets rise. Pits stick once placed. */
function applyStructurePerks(raid: RaidState, _prev: ActivePerkMods, next: ActivePerkMods): RaidState {
  let tiles = raid.map.tiles
  let walls = raid.map.walls
  let mobs = raid.mobs
  let wallsPerkPlaced = raid.wallsPerkPlaced
  let wallsPerkCells = [...raid.wallsPerkCells]
  let hordePerkSpawned = raid.hordePerkSpawned
  const log = [...raid.log]

  // Stamp already-baked pits (e.g. from a previous floor / create) before counting need
  if (wallsPerkCells.length) {
    tiles = [...tiles]
    stampPerkPits(tiles, wallsPerkCells)
    walls = rebuildWallSet(tiles)
  }

  // Keyed by layout (not generation order) so one layout always gets the same pits:
  // Create preview = every raid, and calibration by map seed carries over to the game
  const layoutKey = raid.mapSeed ?? dungeonHash(raid.dungeonId)
  const wallsTarget = rollWallsTarget(
    next,
    mulberry32((layoutKey ^ (next.wallsExtra * 0x9e3779b1) ^ 0x57414c53) >>> 0),
  )
  const wallNeed = Math.max(0, wallsTarget - wallsPerkPlaced)
  if (wallNeed > 0) {
    tiles = tiles === raid.map.tiles ? [...tiles] : tiles
    const blocked = new Set<string>()
    blocked.add(cellKey(raid.friend.x, raid.friend.y))
    for (const m of mobs) {
      if (m.hp > 0) blocked.add(cellKey(m.x, m.y))
    }
    // Stable per layout + how many pits already locked — never re-roll prior pits
    const wallRng = mulberry32(
      (layoutKey ^
        (wallsPerkPlaced * 0x85ebca6b) ^
        (wallsTarget * 0xc2b2ae35) ^
        0x50495453) >>>
        0,
    )
    const newKeys = addExtraWalls(tiles, wallNeed, wallRng, blocked)
    wallsPerkPlaced += newKeys.length
    wallsPerkCells = [...wallsPerkCells, ...newKeys]
    walls = rebuildWallSet(tiles)

    // Safety: never leave a mob standing on a new pit
    const relocated = relocateOffPits(
      tiles,
      mobs.filter((m) => m.hp > 0).map((m) => ({ x: m.x, y: m.y })),
      wallRng,
      new Set([cellKey(raid.friend.x, raid.friend.y)]),
    )
    let ri = 0
    mobs = mobs.map((m) => {
      if (m.hp <= 0) return m
      const pos = relocated[ri++]
      return pos ? { ...m, x: pos.x, y: pos.y } : m
    })

    if (newKeys.length > 0) {
      log.push(`[PITS] +${newKeys.length} pit(s) (perk total ${wallsPerkPlaced})`)
    }
  }

  // Sticky roll per floor+rank so re-syncs do not re-roll spawn count
  const hordeRng = mulberry32(
    (raid.raidSeed ^ ((raid.floor + 1) * 104729) ^ (next.hordeRank * 2654435761) ^ 0x40de) >>> 0,
  )
  const hordeTarget = rollHordeCount(next.hordeRank, hordeRng, raid.isCorridor)
  const hordeNeed = Math.max(0, hordeTarget - hordePerkSpawned)
  if (hordeNeed > 0) {
    const occupied = new Set<string>()
    occupied.add(cellKey(raid.friend.x, raid.friend.y))
    for (const m of mobs) {
      if (m.hp > 0) occupied.add(cellKey(m.x, m.y))
    }
    // Floor only — pits already excluded (not floor tiles)
    const spawns = pickHordeSpawnCells(tiles, hordeNeed, hordeRng, occupied)
    if (spawns.length) {
      const maxId = mobs.reduce((a, m) => Math.max(a, m.id), 0)
      const hp = 1 + next.mobHpBonus
      const added: Mob[] = spawns.map((s, i) => ({
        id: maxId + i + 1,
        x: s.x,
        y: s.y,
        hp,
        lastDx: 0,
        lastDy: 0,
        aggro: false,
        fromHorde: true,
      }))
      mobs = [...mobs, ...added]
      hordePerkSpawned += added.length
      log.push(`[HORDE] +${added.length} mob(s) (perk total ${hordePerkSpawned}/${hordeTarget})`)
    }
  }

  return {
    ...raid,
    map: { tiles, walls },
    mobs,
    wallsPerkPlaced,
    wallsPerkCells,
    hordePerkSpawned,
    log,
  }
}

export function syncRaidWithPerks(raid: RaidState, perks: PerksState): RaidState {
  const prev = raid.perkMods
  const softEase =
    raid.softEase ??
    (raid.tier === 'soft'
      ? {
          staminaBonus: SOFT.friendStaminaBonus,
          frightCut: SOFT.friendFrightCut,
          dodgeFloor: SOFT.friendDodgeFloor,
          dungeonEfficacy: SOFT.dungeonEfficacy,
        }
      : raid.tier === 'hard' && (HARD.friendStaminaBonus || HARD.friendFrightCut)
        ? {
            staminaBonus: HARD.friendStaminaBonus,
            frightCut: HARD.friendFrightCut,
            dodgeFloor: HARD.friendDodgeFloor,
          }
        : undefined)
  const next = derivePerkMods(perks, {
    dungeonScale: raid.dungeonPowerScale ?? 1,
    softEase,
    dangerMap: raid.isCorridor,
  })
  const baseSta = raid.floorBaseStamina ?? 15
  const oldMax = friendMaxStamina(prev, baseSta)
  const newMax = friendMaxStamina(next, baseSta)
  const vision = friendVision(next)

  let stamina = raid.friend.stamina
  const delta = newMax - oldMax
  if (delta !== 0) {
    stamina = Math.min(newMax, Math.max(1, stamina + delta))
  }

  const hpDelta = next.mobHpBonus - prev.mobHpBonus
  const mobs =
    hpDelta === 0
      ? raid.mobs
      : raid.mobs.map((m) => (m.hp > 0 ? { ...m, hp: m.hp + hpDelta } : m))

  let synced: RaidState = {
    ...raid,
    perkMods: next,
    friend: {
      ...raid.friend,
      vision,
      stamina,
    },
    mobs,
    log: [
      ...raid.log,
      `Perks sync: VIS ${vision}, STA ${stamina}/${newMax}, fright ${25 + next.dreadBonus + next.fogFrightBonus - next.fearlessCut - next.eyeFrightCut}%`,
    ],
  }

  synced = applyStructurePerks(synced, prev, next)
  return synced
}

/** Re-apply Pits/Horde targets on a fresh floor (Horde counters at 0; pits stay locked). */
export function ensureStructurePerks(raid: RaidState): RaidState {
  return applyStructurePerks(raid, emptyPerkMods(), raid.perkMods)
}

export { emptyPerkMods, derivePerkMods, friendMaxStamina, friendVision }
export type { ActivePerkMods }
