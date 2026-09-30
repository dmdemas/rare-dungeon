import { DIRS, FRIEND_DIRS, MAP_H, MAP_W } from './config'
import type { Cell, TileKind } from './types'

export function inBounds(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H
}

export function neighbors4(x: number, y: number): Cell[] {
  const out: Cell[] = []
  for (const { dx, dy } of DIRS) {
    const nx = x + dx
    const ny = y + dy
    if (inBounds(nx, ny)) out.push({ x: nx, y: ny })
  }
  return out
}

/** Orthogonal neighbors with Friend bias: forward (+x) before lateral. */
export function neighbors4Forward(x: number, y: number): Cell[] {
  const out: Cell[] = []
  for (const { dx, dy } of FRIEND_DIRS) {
    const nx = x + dx
    const ny = y + dy
    if (inBounds(nx, ny)) out.push({ x: nx, y: ny })
  }
  return out
}

export function chebyshev(a: Cell, b: Cell): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

export function manhattan(a: Cell, b: Cell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

/** BFS path on walkable predicate. Returns path including start, or null. */
export function bfsPath(
  start: Cell,
  goal: Cell | ((c: Cell) => boolean),
  walkable: (c: Cell) => boolean,
  /** Neighbor order; default orthogonal. Friend uses forward-first. */
  neighbors: (x: number, y: number) => Cell[] = neighbors4,
): Cell[] | null {
  const goalFn = typeof goal === 'function' ? goal : (c: Cell) => c.x === goal.x && c.y === goal.y
  if (!walkable(start)) return null

  const q: Cell[] = [start]
  const prev = BFS_PREV.fill(UNSEEN)
  prev[start.y * MAP_W + start.x] = ROOT

  for (let head = 0; head < q.length; head++) {
    const cur = q[head]!
    if (goalFn(cur)) {
      const path: Cell[] = []
      for (let i = cur.y * MAP_W + cur.x; i !== ROOT; i = prev[i]!) {
        path.push({ x: i % MAP_W, y: Math.floor(i / MAP_W) })
      }
      path.reverse()
      return path
    }
    const curIdx = cur.y * MAP_W + cur.x
    const list =
      neighbors === neighbors4
        ? NEIGHBORS_4[curIdx]!
        : neighbors === neighbors4Forward
          ? NEIGHBORS_FORWARD[curIdx]!
          : neighbors(cur.x, cur.y)
    for (const n of list) {
      const ni = n.y * MAP_W + n.x
      if (prev[ni] !== UNSEEN) continue
      if (!walkable(n)) continue
      prev[ni] = curIdx
      q.push(n)
    }
  }
  return null
}

const UNSEEN = -2
const ROOT = -1
/** Shared scratch buffer — bfsPath is synchronous and never re-entered. */
const BFS_PREV = new Int16Array(MAP_W * MAP_H)

/** Internal to bfsPath only — callers of neighbors4* get fresh arrays they may mutate. */
function neighborTable(fn: (x: number, y: number) => Cell[]): readonly Cell[][] {
  return Array.from({ length: MAP_W * MAP_H }, (_, i) => fn(i % MAP_W, Math.floor(i / MAP_W)))
}
const NEIGHBORS_4 = neighborTable(neighbors4)
const NEIGHBORS_FORWARD = neighborTable(neighbors4Forward)

/** Shortest path preferring depth-forward steps when several equal-length routes exist. */
export function bfsPathForward(
  start: Cell,
  goal: Cell | ((c: Cell) => boolean),
  walkable: (c: Cell) => boolean,
): Cell[] | null {
  return bfsPath(start, goal, walkable, neighbors4Forward)
}

export function hasPath(
  start: Cell,
  goal: Cell,
  isBlocked: (x: number, y: number) => boolean,
): boolean {
  return (
    bfsPath(start, goal, (c) => !isBlocked(c.x, c.y)) !== null
  )
}

export function tileAt(tiles: TileKind[], x: number, y: number): TileKind {
  return tiles[y * MAP_W + x]!
}
