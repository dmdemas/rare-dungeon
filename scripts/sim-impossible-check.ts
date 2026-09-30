/**
 * Impossibility check v2 — two-phase:
 *   Phase 1: BFS pathfinding on 2000 blueprints (very fast)
 *   Phase 2: Combat on flagged/random sample — can "best case" raider ever clear?
 *
 *   npx tsx scripts/sim-impossible-check.ts
 */
import { generateBlueprint, getEntranceCell, getExitCell } from '../src/game/mapGen.ts'
import { MAP_W, MAP_H } from '../src/game/config.ts'
import { hasPath } from '../src/game/pathfinding.ts'
import {
  createEmptyPerksState,
  createEmptySideState,
  selectFriendPerk,
  selectPerk,
  revealDungeonPick,
  syncRaidWithPerks,
  type FriendPerkId,
  type DungeonPerkId,
} from '../src/game/perks/index.ts'
import { startRaid, tickRaid, advanceFloor } from '../src/game/raid.ts'
import type { DungeonBlueprint, TileKind } from '../src/game/types.ts'

// ── helpers ────────────────────────────────────────────────────────────────

function tileAt(tiles: TileKind[], x: number, y: number): TileKind {
  if (x < 0 || x >= MAP_W || y < 0 || y >= MAP_H) return 'wall'
  return tiles[y * MAP_W + x]!
}

function mapIsConnected(bp: DungeonBlueprint): boolean {
  const { tiles } = bp.map
  return hasPath(
    getEntranceCell(tiles),
    getExitCell(tiles),
    (x, y) => tileAt(tiles, x, y) === 'wall',
  )
}

function buildPlanned(perkId: DungeonPerkId | null) {
  if (!perkId) return { picks: [] as { id: DungeonPerkId; rank: 1|2|3 }[] }
  let side = createEmptySideState<DungeonPerkId>()
  const picks: { id: DungeonPerkId; rank: 1|2|3 }[] = []
  for (let slot = 0; slot < 3; slot++) {
    side = selectPerk(side, perkId)
    const rank = side.ranks[perkId]
    if (rank) picks.push({ id: perkId, rank })
  }
  return { picks }
}

function playOne(
  bp: DungeonBlueprint,
  friendPerk: FriendPerkId | null,
  dungeonPerk: DungeonPerkId | null,
): boolean {
  const planned = buildPlanned(dungeonPerk)
  let perks = createEmptyPerksState()
  let raid  = startRaid(bp, 1)

  for (let floor = 1; floor <= 3; floor++) {
    if (floor > 1) raid = advanceFloor(raid, bp)
    perks = { ...perks, dungeon: revealDungeonPick(perks.dungeon, planned, floor - 1) }
    if (friendPerk) perks = selectFriendPerk(perks, friendPerk)
    raid = syncRaidWithPerks(raid, perks)

    let t = 0
    while (raid.phase === 'running' && t++ < 600) {
      raid = tickRaid(raid)
    }

    if (raid.phase === 'won') return true
    if (raid.phase === 'floorClear' && floor >= 3) return true
    if (raid.phase === 'floorClear') continue  // next floor
    return false  // dead or stuck
  }
  return false
}

function bestCaseClearRate(bp: DungeonBlueprint, K: number): number {
  const friendPerks: Array<FriendPerkId|null> = ['dash', 'endurance', 'rally', 'fearless', null]
  let best = 0
  for (const fp of friendPerks) {
    let c = 0
    for (let i = 0; i < K; i++) {
      if (playOne(bp, fp, null)) c++
    }
    const r = c / K
    if (r > best) best = r
    if (best > 0.05) break  // found a working perk — skip rest
  }
  return best
}

// ── Phase 1: Pathfinding on N blueprints ──────────────────────────────────

const N_PATH = 2000
const TIERS: Array<'soft'|'hard'> = ['soft', 'hard']

console.log(`\n══ PHASE 1: BFS pathfinding — ${N_PATH} dungeons × 2 tiers = ${N_PATH*2} blueprints ══\n`)

let noPath = 0
const noPathSeeds: {seed:number; tier:string}[] = []

for (let i = 0; i < N_PATH; i++) {
  for (const tier of TIERS) {
    const seed = (i * 0xdeadbeef + (tier === 'hard' ? 0x80000000 : 0)) >>> 0
    const bp: DungeonBlueprint = {
      ...generateBlueprint(seed, 'v'),
      tier,
      dungeonPowerScale: tier === 'hard' ? 0.92 : 0.4,
    }
    if (!mapIsConnected(bp)) {
      noPath++
      noPathSeeds.push({ seed, tier })
    }
  }
}

const pct = (x:number,n:number) => `${(100*x/n).toFixed(2)}%`
console.log(`  Maps with NO path entrance→exit: ${noPath} / ${N_PATH*2}  (${pct(noPath, N_PATH*2)})`)
if (noPathSeeds.length > 0) {
  console.log(`  First blocked maps:`)
  noPathSeeds.slice(0, 5).forEach(s => console.log(`    seed=0x${s.seed.toString(16).padStart(8,'0')} tier=${s.tier}`))
} else {
  console.log(`  ✅ All maps have a valid path`)
}

// ── Phase 2: Walls perk stress — does adding Walls ever block path? ───────

console.log(`\n══ PHASE 2: Walls perk — does adding pits ever block path? (500 dungeons) ══\n`)

let wallsBlockedPath = 0
let wallsBlockedCount = 0
const WALLS_TESTS = 500

for (let i = 0; i < WALLS_TESTS; i++) {
  const seed = (i * 0x14057b7ef + 0x12345678) >>> 0
  const bp: DungeonBlueprint = {
    ...generateBlueprint(seed, 'v'),
    tier: 'soft',
    dungeonPowerScale: 0.4,
  }

  // Simulate Walls perk adding extra tiles (check if pathfinding breaks)
  const planned = buildPlanned('walls')
  let perks = createEmptyPerksState()
  let raid  = startRaid(bp, 1)
  perks = { ...perks, dungeon: revealDungeonPick(perks.dungeon, planned, 0) }
  raid = syncRaidWithPerks(raid, perks)

  // Check if map is still connected after walls perk placed tiles
  const connected = hasPath(
    getEntranceCell(raid.map.tiles),
    getExitCell(raid.map.tiles),
    (x, y) => tileAt(raid.map.tiles, x, y) === 'wall',
  )
  if (!connected) { wallsBlockedPath++; wallsBlockedCount++ }
}

console.log(`  After Walls perk (rank 1) placed: path blocked in ${wallsBlockedPath} / ${WALLS_TESTS}  (${pct(wallsBlockedPath,WALLS_TESTS)})`)
if (wallsBlockedPath === 0) console.log(`  ✅ Walls perk never blocks the path`)

// ── Phase 3: Combat "hard floor" — minimum clear rate across 200 dungeons ──

console.log(`\n══ PHASE 3: Combat "near-zero clear" check — 200 dungeons × 50 best-case attempts ══\n`)

const N_COMBAT  = 200
const K_EACH    = 50
let   zeroClear = 0
let   lowClear  = 0  // < 5%
const worstList: {seed:number; tier:string; clearRate:number}[] = []

for (let i = 0; i < N_COMBAT; i++) {
  for (const tier of TIERS) {
    const seed = (i * 0x4c957f2d + (tier === 'hard' ? 0xc0000000 : 0x40000000)) >>> 0
    const bp: DungeonBlueprint = {
      ...generateBlueprint(seed, 'v'),
      tier,
      dungeonPowerScale: tier === 'hard' ? 0.92 : 0.4,
    }
    if (!mapIsConnected(bp)) continue

    const r = bestCaseClearRate(bp, K_EACH)
    if (r === 0)    zeroClear++
    if (r < 0.05)   lowClear++
    if (r < 0.10)   worstList.push({ seed, tier, clearRate: r })
  }
}

worstList.sort((a, b) => a.clearRate - b.clearRate)
const combatTotal = N_COMBAT * TIERS.length

console.log(`  Tested: ${combatTotal} dungeons (${K_EACH} best-case attempts each, Friend=Dash, no dungeon perk)`)
console.log(`  clearRate = 0%  (zero clears in ${K_EACH} attempts): ${zeroClear}  (${pct(zeroClear, combatTotal)})`)
console.log(`  clearRate < 5%:   ${lowClear}  (${pct(lowClear, combatTotal)})`)
console.log()

if (worstList.length === 0) {
  console.log(`  ✅ All dungeons cleared at least once with Dash in ${K_EACH} attempts`)
} else {
  console.log(`  Near-impossible dungeons (clearRate < 10%):`)
  worstList.slice(0, 10).forEach(d =>
    console.log(`    seed=0x${d.seed.toString(16).padStart(8,'0')} tier=${d.tier}  clearRate=${(d.clearRate*100).toFixed(0)}%`)
  )
}

// ── Summary ────────────────────────────────────────────────────────────────

console.log(`\n══ SUMMARY ══`)
console.log(`  Physically impossible (no path):  ${noPath} / ${N_PATH*2}`)
console.log(`  Walls perk blocks path:           ${wallsBlockedPath} / ${WALLS_TESTS}`)
console.log(`  Combat zero-clear (Dash, 50 att): ${zeroClear} / ${combatTotal}`)
console.log(`  Combat <5% clear:                 ${lowClear} / ${combatTotal}`)
