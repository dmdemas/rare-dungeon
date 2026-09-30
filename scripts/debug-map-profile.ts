import { generateBlueprint, getEntranceCell, getExitCell } from '../src/game/mapGen.ts'
import { MAP_W, MAP_H } from '../src/game/config.ts'
import { hasPath } from '../src/game/pathfinding.ts'
import { cellKey } from '../src/game/types.ts'
import type { DungeonBlueprint, TileKind } from '../src/game/types.ts'

function tileAt(tiles: TileKind[], x: number, y: number): TileKind {
  if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) return 'wall'
  return tiles[y * MAP_W + x]!
}

function freeNeighbors(tiles: TileKind[], x: number, y: number): number {
  return [[0,1],[0,-1],[1,0],[-1,0]].filter(([dx,dy]) =>
    tileAt(tiles, x+dx!, y+dy!) !== 'wall'
  ).length
}

/** Count chokepoint cells: free cells with only 1 or 2 free neighbors */
function chokepoints(tiles: TileKind[]): { narrow1: number; narrow2: number } {
  let narrow1=0, narrow2=0
  for (let y=0; y<MAP_H; y++) for (let x=0; x<MAP_W; x++) {
    if (tileAt(tiles,x,y)==='wall') continue
    const n = freeNeighbors(tiles,x,y)
    if (n===1) narrow1++
    else if (n===2) narrow2++
  }
  return { narrow1, narrow2 }
}

/** Shortest BFS path length entrance→exit */
function pathLength(tiles: TileKind[]): number {
  const start = getEntranceCell(tiles)
  const goal  = getExitCell(tiles)
  const visited = new Set<string>()
  const queue: [number,number,number][] = [[start.x, start.y, 0]]
  while (queue.length) {
    const [x,y,d] = queue.shift()!
    const k = cellKey(x,y)
    if (visited.has(k)) continue
    visited.add(k)
    if (x===goal.x && y===goal.y) return d
    for (const [dx,dy] of [[0,1],[0,-1],[1,0],[-1,0]] as [number,number][]) {
      const nx=x+dx, ny=y+dy
      if (tileAt(tiles,nx,ny)!=='wall') queue.push([nx,ny,d+1])
    }
  }
  return 999
}

/** Free cells count */
function freeCells(tiles: TileKind[]): number {
  return tiles.filter(t => t !== 'wall').length
}

// ── collect stats on 200 blueprints ──────────────────────────────────────

// Known zero-clear Hard seeds (< 5% with any perk)
const HARD_ZERO = [
  0xf255fcb4, 0x8957f2d0, 0xee03ec38, 0xd19b6181,
  0x6ac65fdb, 0x36475ae9, 0xcf725943, 0x1c07d870, 0x01c855f7, 0x9af35451,
]

// Random normal Hard seeds (clearable)
const HARD_NORMAL: number[] = []
for (let i=0; i<200; i++) HARD_NORMAL.push((i * 0x4c957f2d + 0xc0000000) >>> 0)

type Stats = {
  walls: number; mobs: number; free: number
  narrow1: number; narrow2: number; pathLen: number
  chokeDensity: number  // (narrow1+narrow2) / free
}

function stats(seed: number): Stats {
  const bp: DungeonBlueprint = { ...generateBlueprint(seed >>> 0, 'v'), tier: 'hard', dungeonPowerScale: 0.92 }
  const { tiles } = bp.map
  const walls = tiles.filter(t => t === 'wall').length
  const mobs  = bp.mobSpawns?.length ?? 0
  const free  = freeCells(tiles)
  const { narrow1, narrow2 } = chokepoints(tiles)
  const pathLen = pathLength(tiles)
  return { walls, mobs, free, narrow1, narrow2, pathLen, chokeDensity: (narrow1+narrow2)/free }
}

const zeroStats  = HARD_ZERO.map(s => ({ seed: s, ...stats(s) }))
const normalStats = HARD_NORMAL
  .filter(s => !HARD_ZERO.includes(s))
  .slice(0, 50)  // compare 50 normal
  .map(s => ({ seed: s, ...stats(s) }))

function avg(arr: number[]): number { return arr.reduce((a,b)=>a+b,0)/arr.length }
function median(arr: number[]): number {
  const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]!
}

const fields: (keyof Stats)[] = ['walls','mobs','narrow1','narrow2','chokeDensity','pathLen']

console.log('\n══ Typological profile: zero-clear Hard vs normal Hard ══\n')
console.log('Metric            zero-clear (n='+zeroStats.length+')   normal (n='+normalStats.length+')')
console.log('─'.repeat(55))
for (const f of fields) {
  const zv = zeroStats.map(s=>s[f] as number)
  const nv = normalStats.map(s=>s[f] as number)
  console.log(
    String(f).padEnd(18)+
    `avg=${avg(zv).toFixed(2)} med=${median(zv)}`.padEnd(24)+
    `avg=${avg(nv).toFixed(2)} med=${median(nv)}`
  )
}

console.log('\n══ Individual zero-clear maps ══')
for (const s of zeroStats) {
  console.log(`seed=0x${s.seed.toString(16).padStart(8,'0')}  walls=${s.walls} mobs=${s.mobs} narrow2=${s.narrow2} chokeDens=${s.chokeDensity.toFixed(2)} pathLen=${s.pathLen}`)
}
