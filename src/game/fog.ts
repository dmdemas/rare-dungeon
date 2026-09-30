import { BASE_VISION, MAP_H, MAP_W } from './config'
import { getEntranceCell } from './mapGen'
import { chebyshev, tileAt } from './pathfinding'
import type { DungeonMap, FriendState, Knowledge, Mob, RaidPerkMods } from './types'
import { cellKey } from './types'

export function createKnowledge(): Knowledge {
  return {
    revealed: new Set(),
    tiles: new Map(),
    mobs: new Map(),
    knowsExit: false,
    exitCell: null,
  }
}

export function revealAround(
  knowledge: Knowledge,
  map: DungeonMap,
  friend: FriendState,
  mobs: Mob[],
): void {
  const v = friend.vision
  const y0 = Math.max(0, Math.ceil(friend.y - v))
  const y1 = Math.min(MAP_H - 1, Math.floor(friend.y + v))
  const x0 = Math.max(0, Math.ceil(friend.x - v))
  const x1 = Math.min(MAP_W - 1, Math.floor(friend.x + v))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const key = cellKey(x, y)
      knowledge.revealed.add(key)
      knowledge.tiles.set(key, tileAt(map.tiles, x, y))
      const kind = tileAt(map.tiles, x, y)
      if (kind === 'exit') {
        knowledge.knowsExit = true
        knowledge.exitCell = { x, y }
      }
      if (kind === 'entrance') {
        knowledge.tiles.set(key, 'entrance')
      }
    }
  }

  // Update mob memory: visible always; also track across explored (revealed) cells
  // so mobs don't vanish when walking behind Friend toward spawn.
  for (const mob of mobs) {
    if (mob.hp <= 0) {
      knowledge.mobs.delete(mob.id)
      continue
    }
    const key = cellKey(mob.x, mob.y)
    const visible = chebyshev(mob, friend) <= friend.vision
    if (visible) {
      knowledge.mobs.set(mob.id, key)
    } else if (knowledge.revealed.has(key) && knowledge.mobs.has(mob.id)) {
      knowledge.mobs.set(mob.id, key)
    }
  }

  // Clear memory for dead / if last-known cell is in vision but empty
  for (const [id, key] of [...knowledge.mobs.entries()]) {
    const live = mobs.find((m) => m.id === id && m.hp > 0)
    if (!live) {
      knowledge.mobs.delete(id)
      continue
    }
    const [xs, ys] = key.split(',')
    const cell = { x: Number(xs), y: Number(ys) }
    if (
      chebyshev(cell, friend) <= friend.vision &&
      cellKey(live.x, live.y) !== key
    ) {
      // Stale memory in vision — refresh to live pos if visible, else drop
      if (chebyshev(live, friend) <= friend.vision) {
        knowledge.mobs.set(id, cellKey(live.x, live.y))
      } else {
        knowledge.mobs.delete(id)
      }
    }
  }

  // Always know entrance at start
  const ent = getEntranceCell(map.tiles)
  knowledge.revealed.add(cellKey(ent.x, ent.y))
  knowledge.tiles.set(cellKey(ent.x, ent.y), 'entrance')
}

export function isCurrentlyVisible(friend: FriendState, x: number, y: number): boolean {
  return chebyshev({ x, y }, friend) <= friend.vision
}

/**
 * Vision radius without Sharp Eye (Fog still applies).
 * Sharp Eye cells are those beyond this but within friend.vision.
 */
export function visionWithoutSharpEye(mods: RaidPerkMods): number {
  return Math.max(1, BASE_VISION - mods.fogPenalty)
}

/**
 * Contour index 1..3 for cells only seen thanks to Sharp Eye.
 * Farther rings are stronger (caller maps ring → green intensity).
 * 0 = not a Sharp Eye bonus cell.
 */
export function sharpEyeRing(
  friend: FriendState,
  mods: RaidPerkMods,
  x: number,
  y: number,
): 0 | 1 | 2 | 3 {
  if (mods.visionBonus <= 0) return 0
  const base = visionWithoutSharpEye(mods)
  const d = chebyshev({ x, y }, friend)
  if (d <= base || d > friend.vision) return 0
  const ring = d - base
  if (ring === 1 || ring === 2 || ring === 3) return ring
  return 0
}

export function knownWalkable(
  knowledge: Knowledge,
  x: number,
  y: number,
  treatMobsBlocked: boolean,
): boolean {
  const key = cellKey(x, y)
  if (!knowledge.revealed.has(key)) return false
  const kind = knowledge.tiles.get(key)
  if (kind === 'wall') return false
  if (treatMobsBlocked) {
    for (const mk of knowledge.mobs.values()) {
      if (mk === key) return false
    }
  }
  return true
}

export function bootstrapKnowledge(
  map: DungeonMap,
  friend: FriendState,
  mobs: Mob[],
): Knowledge {
  const k = createKnowledge()
  revealAround(k, map, friend, mobs)
  return k
}
