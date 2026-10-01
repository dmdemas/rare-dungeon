import {
  ENTRANCE_X,
  EXIT_X,
  MAP_H,
  MAP_W,
  MOB_COUNT_WEIGHTS,
  HARD_MOB_COUNT_WEIGHTS,
  WALL_COUNT_WEIGHTS,
} from './config'
import { bfsPath, hasPath, inBounds, neighbors4 } from './pathfinding'
import { chance, mulberry32, pickWeighted, shuffleInPlace, type Rng } from './rng'
import type { Cell, DungeonBlueprint, DungeonMap, TileKind } from './types'
import { cellKey } from './types'

/** 2nd or 3rd cell of a 4-lane row (y = 1 | 2), 50/50. */
function pickEdgeLane(rng: Rng): number {
  return chance(rng, 0.5) ? 1 : 2
}

function findKind(tiles: TileKind[], kind: TileKind): Cell | null {
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (tiles[y * MAP_W + x] === kind) return { x, y }
    }
  }
  return null
}

export function getEntranceCell(tiles: TileKind[]): Cell {
  return findKind(tiles, 'entrance') ?? { x: ENTRANCE_X, y: 1 }
}

export function getExitCell(tiles: TileKind[]): Cell {
  return findKind(tiles, 'exit') ?? { x: EXIT_X, y: 1 }
}

function isSpawnForbidden(x: number, _y: number): boolean {
  return x === ENTRANCE_X || x === EXIT_X
}

function emptyTiles(rng: Rng): TileKind[] {
  const entranceY = pickEdgeLane(rng)
  const exitY = pickEdgeLane(rng)
  const tiles: TileKind[] = Array.from({ length: MAP_W * MAP_H }, () => 'floor')
  for (let y = 0; y < MAP_H; y++) {
    tiles[y * MAP_W + ENTRANCE_X] = 'floor'
    tiles[y * MAP_W + EXIT_X] = 'floor'
  }
  tiles[entranceY * MAP_W + ENTRANCE_X] = 'entrance'
  tiles[exitY * MAP_W + EXIT_X] = 'exit'
  return tiles
}

function wallSetFromTiles(tiles: TileKind[]): Set<string> {
  const walls = new Set<string>()
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (tiles[y * MAP_W + x] === 'wall') walls.add(cellKey(x, y))
    }
  }
  return walls
}

function setWall(tiles: TileKind[], x: number, y: number, on: boolean): void {
  if (!inBounds(x, y) || isSpawnForbidden(x, y)) return
  if (tiles[y * MAP_W + x] === 'entrance' || tiles[y * MAP_W + x] === 'exit') return
  tiles[y * MAP_W + x] = on ? 'wall' : 'floor'
}

function horizontalRunOk(tiles: TileKind[], x: number, y: number): boolean {
  // No more than 3 walls in a horizontal row including this cell.
  let run = 1
  for (let i = x - 1; i >= 0; i--) {
    if (tiles[y * MAP_W + i] === 'wall') run++
    else break
  }
  for (let i = x + 1; i < MAP_W; i++) {
    if (tiles[y * MAP_W + i] === 'wall') run++
    else break
  }
  return run <= 3
}

function pathOpen(tiles: TileKind[]): boolean {
  const start = getEntranceCell(tiles)
  const goal = getExitCell(tiles)
  return hasPath(start, goal, (x, y) => tiles[y * MAP_W + x] === 'wall')
}

function placeWallChunk(
  rng: Rng,
  tiles: TileKind[],
  existing: Set<string>,
  blocked?: Set<string>,
): boolean {
  type Mode = 'glue' | 'edge' | 'new'
  const roll = rng()
  const mode: Mode = roll < 0.5 ? 'glue' : roll < 0.75 ? 'edge' : 'new'

  const candidates: { x: number; y: number }[] = []
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (isSpawnForbidden(x, y)) continue
      if (tiles[y * MAP_W + x] !== 'floor') continue
      if (blocked?.has(cellKey(x, y))) continue
      candidates.push({ x, y })
    }
  }
  if (!candidates.length) return false

  let cells: { x: number; y: number }[] = []

  if (mode === 'glue' && existing.size > 0) {
    const glued = candidates.filter((c) =>
      neighbors4(c.x, c.y).some((n) => existing.has(cellKey(n.x, n.y))),
    )
    if (glued.length) {
      const pick = glued[Math.floor(rng() * glued.length)]!
      cells = [pick]
    }
  } else if (mode === 'edge') {
    const edged = candidates.filter((c) => c.y === 0 || c.y === MAP_H - 1)
    if (edged.length) {
      const pick = edged[Math.floor(rng() * edged.length)]!
      cells = [pick]
    }
  }

  if (!cells.length) {
    // New chunk of 2–3 in a line
    const len = chance(rng, 0.5) ? 2 : 3
    const start = candidates[Math.floor(rng() * candidates.length)]!
    const horiz = chance(rng, 0.5)
    cells = []
    for (let i = 0; i < len; i++) {
      const x = horiz ? start.x + i : start.x
      const y = horiz ? start.y : start.y + i
      if (!inBounds(x, y) || isSpawnForbidden(x, y)) break
      if (tiles[y * MAP_W + x] !== 'floor') break
      if (blocked?.has(cellKey(x, y))) break
      cells.push({ x, y })
    }
    if (!cells.length) cells = [start]
  }

  const applied: { x: number; y: number }[] = []
  for (const c of cells) {
    if (blocked?.has(cellKey(c.x, c.y))) continue
    setWall(tiles, c.x, c.y, true)
    if (!horizontalRunOk(tiles, c.x, c.y) || !pathOpen(tiles)) {
      setWall(tiles, c.x, c.y, false)
      continue
    }
    applied.push(c)
    existing.add(cellKey(c.x, c.y))
  }
  return applied.length > 0
}

function placeWalls(rng: Rng, tiles: TileKind[], targetCount: number): void {
  const existing = new Set<string>()
  let placed = 0
  let attempts = 0
  const maxAttempts = targetCount * 40
  while (placed < targetCount && attempts < maxAttempts) {
    attempts++
    const before = existing.size
    if (placeWallChunk(rng, tiles, existing)) {
      const gained = existing.size - before
      placed += gained
    }
  }
}

function spawnMobs(
  rng: Rng,
  tiles: TileKind[],
  count: number,
): { x: number; y: number }[] {
  const slots: { x: number; y: number }[] = []
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (isSpawnForbidden(x, y)) continue
      if (tiles[y * MAP_W + x] !== 'floor') continue
      slots.push({ x, y })
    }
  }
  shuffleInPlace(rng, slots)
  const target = Math.max(1, count)
  const picked = slots.slice(0, Math.min(target, slots.length))

  // Ensure mobs don't block the only path: if path broken with all mobs as blocked, drop until path exists
  const start = getEntranceCell(tiles)
  const goal = getExitCell(tiles)
  const pathOk = (list: { x: number; y: number }[]) => {
    const blocked = new Set(list.map((p) => cellKey(p.x, p.y)))
    return (
      bfsPath(start, goal, (c) => {
        if (tiles[c.y * MAP_W + c.x] === 'wall') return false
        if (blocked.has(cellKey(c.x, c.y))) return false
        return true
      }) !== null
    )
  }
  while (picked.length > 1 && !pathOk(picked)) {
    picked.pop()
  }

  // Always at least 1 on free floor (never entrance/exit/wall)
  if (picked.length === 0) {
    const free = slots.filter((s) => pathOk([s]))
    const pool = free.length ? free : slots
    if (pool.length) {
      picked.push(pool[Math.floor(rng() * pool.length)]!)
    } else {
      // Absolute fallback: first non-forbidden floor
      for (let y = 0; y < MAP_H; y++) {
        for (let x = 0; x < MAP_W; x++) {
          if (isSpawnForbidden(x, y)) continue
          if (tiles[y * MAP_W + x] === 'floor') {
            picked.push({ x, y })
            break
          }
        }
        if (picked.length) break
      }
    }
  }
  return picked
}

export function generateMap(
  rng: Rng,
  mobWeights = MOB_COUNT_WEIGHTS,
): { map: DungeonMap; mobSpawns: { x: number; y: number }[] } {
  let best: { map: DungeonMap; mobSpawns: { x: number; y: number }[] } | null = null
  for (let attempt = 0; attempt < 30; attempt++) {
    const tiles = emptyTiles(rng)
    const wallTarget = pickWeighted(rng, WALL_COUNT_WEIGHTS).count
    placeWalls(rng, tiles, wallTarget)
    if (!pathOpen(tiles)) continue
    const mobCount = pickWeighted(rng, mobWeights).count
    const mobSpawns = spawnMobs(rng, tiles, mobCount)
    if (mobSpawns.length < 1) continue
    const map: DungeonMap = { tiles: [...tiles], walls: wallSetFromTiles(tiles) }
    best = { map, mobSpawns }
    break
  }
  if (!best) {
    const tiles = emptyTiles(rng)
    const mobSpawns = spawnMobs(rng, tiles, 1)
    best = { map: { tiles, walls: new Set() }, mobSpawns }
  }
  return best
}

/**
 * Place up to `count` extra pit cells. Never blocks entrance→exit.
 * Never places on `blocked` cells (living mobs / Friend).
 * Returns newly placed pit cell keys.
 */
export function addExtraWalls(
  tiles: TileKind[],
  count: number,
  rng: Rng,
  blocked?: Set<string>,
): string[] {
  if (count <= 0) return []
  const existing = new Set<string>()
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (tiles[y * MAP_W + x] === 'wall') existing.add(cellKey(x, y))
    }
  }
  const before = new Set(existing)
  let placed = 0
  let attempts = 0
  const maxAttempts = count * 50
  while (placed < count && attempts < maxAttempts) {
    attempts++
    const sizeBefore = existing.size
    if (placeWallChunk(rng, tiles, existing, blocked)) {
      placed += existing.size - sizeBefore
    }
  }
  const keys: string[] = []
  for (const k of existing) {
    if (!before.has(k)) keys.push(k)
  }
  return keys
}

/** Stamp fixed perk-pit keys onto a map (idempotent). */
export function stampPerkPits(tiles: TileKind[], keys: readonly string[]): void {
  for (const k of keys) {
    const [xs, ys] = k.split(',')
    const x = Number(xs)
    const y = Number(ys)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    if (!inBounds(x, y) || isSpawnForbidden(x, y)) continue
    const i = y * MAP_W + x
    if (tiles[i] === 'entrance' || tiles[i] === 'exit') continue
    tiles[i] = 'wall'
  }
}

export function rebuildWallSet(tiles: TileKind[]): Set<string> {
  return wallSetFromTiles(tiles)
}

/**
 * Move any spawn / mob standing on a pit onto a free floor cell.
 * Prefers keeping path entrance→exit open.
 */
export function relocateOffPits(
  tiles: TileKind[],
  positions: { x: number; y: number }[],
  rng: Rng,
  alsoBlocked?: Set<string>,
): { x: number; y: number }[] {
  const occupied = new Set<string>(alsoBlocked)
  const out: { x: number; y: number }[] = []

  const freeSlots = (): { x: number; y: number }[] => {
    const slots: { x: number; y: number }[] = []
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (isSpawnForbidden(x, y)) continue
        if (tiles[y * MAP_W + x] !== 'floor') continue
        const k = cellKey(x, y)
        if (occupied.has(k)) continue
        slots.push({ x, y })
      }
    }
    shuffleInPlace(rng, slots)
    return slots
  }

  for (const p of positions) {
    const k = cellKey(p.x, p.y)
    if (tiles[p.y * MAP_W + p.x] === 'floor' && !occupied.has(k)) {
      occupied.add(k)
      out.push({ x: p.x, y: p.y })
      continue
    }
    const slots = freeSlots()
    const pick = slots[0]
    if (pick) {
      occupied.add(cellKey(pick.x, pick.y))
      out.push(pick)
    }
    // else drop (no free cell)
  }
  return out
}

/**
 * Pick free floor cells for Horde spawns (not entrance/exit, not occupied).
 */
export function pickHordeSpawnCells(
  tiles: TileKind[],
  count: number,
  rng: Rng,
  occupied: Set<string>,
): Cell[] {
  if (count <= 0) return []
  const slots: Cell[] = []
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      if (isSpawnForbidden(x, y)) continue
      if (tiles[y * MAP_W + x] !== 'floor') continue
      const k = cellKey(x, y)
      if (occupied.has(k)) continue
      slots.push({ x, y })
    }
  }
  shuffleInPlace(rng, slots)
  return slots.slice(0, Math.min(count, slots.length))
}

let idSeq = 1

/**
 * Corridor-safety flag: BFS path entrance→exit ≥ 18 steps AND wall count ≥ 10.
 * When true, Horde/Walls perks use minimum spawn counts and have reduced offer weight.
 */
export function computeCorridorFlag(tiles: TileKind[]): boolean {
  const wallCount = tiles.filter((t) => t === 'wall').length
  if (wallCount < 10) return false
  const start = getEntranceCell(tiles)
  const goal = getExitCell(tiles)
  const path = bfsPath(start, goal, (c) => tiles[c.y * MAP_W + c.x] !== 'wall')
  return path !== null && path.length - 1 >= 18
}

export function generateBlueprint(
  seed?: number,
  name?: string,
  tier: 'soft' | 'hard' = 'soft',
): DungeonBlueprint {
  const mapSeed = seed ?? (Math.random() * 1e9) | 0
  const rng = mulberry32(mapSeed)
  const mobWeights = tier === 'hard' ? HARD_MOB_COUNT_WEIGHTS : MOB_COUNT_WEIGHTS
  const { map, mobSpawns } = generateMap(rng, mobWeights)
  const isCorridor = computeCorridorFlag(map.tiles)
  return {
    id: `dungeon-${idSeq++}`,
    name: name ?? `Dungeon #${idSeq - 1}`,
    map,
    mobSpawns,
    isCorridor,
    mapSeed: mapSeed >>> 0,
  }
}