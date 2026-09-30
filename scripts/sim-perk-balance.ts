/**
 * Headless balance sim — random & “reasonable” pick policies + streak survival.
 *
 *   npx tsx scripts/sim-perk-balance.ts
 */
import { generateBlueprint } from '../src/game/mapGen.ts'
import {
  createEmptyPerksState,
  createEmptySideState,
  FRIEND_PERK_IDS,
  DUNGEON_PERK_IDS,
  PERK_SLOT_COUNT,
  revealDungeonPick,
  rollFriendOffer,
  rollOffer,
  rollPredefinedDungeonPerks,
  selectFriendPerk,
  selectPerk,
  syncRaidWithPerks,
  type DungeonPerkId,
  type FriendPerkId,
  type PerkId,
  type PerksState,
  type PlannedDungeonLoadout,
} from '../src/game/perks/index.ts'
import { advanceFloor, startRaid, tickRaid } from '../src/game/raid.ts'
import { mulberry32 } from '../src/game/rng.ts'
import type { DungeonBlueprint, RaidState } from '../src/game/types.ts'

const RUNS = 1000
const CAUSAL_N = 100
const MAX_TICKS_PER_FLOOR = 600

type Result = 'won' | 'dead'
type PickMode = 'random' | 'smart'

/** Higher = better pick (from prior causal balance). */
const FRIEND_VALUE: Record<FriendPerkId, number> = {
  dash: 100,
  fearless: 92,
  sharpEye: 90,
  endurance: 85,
  rally: 84,
  dodge: 70,
}

const DUNGEON_VALUE: Record<DungeonPerkId, number> = {
  horde: 100,
  dreadfulBeasts: 92,
  fog: 88,
  walls: 85,
  thickHide: 82,
  sharpClaws: 78,
}

type RunLog = {
  result: Result
  floorsCleared: number
  ticks: number
  friendRanks: Partial<Record<FriendPerkId, number>>
  dungeonRanks: Partial<Record<DungeonPerkId, number>>
}

function pct(n: number, d: number): string {
  if (d <= 0) return '—'
  return `${((100 * n) / d).toFixed(1)}%`
}

function pickFriend(
  offer: [FriendPerkId, FriendPerkId],
  mode: PickMode,
  rng: () => number,
): FriendPerkId {
  if (mode === 'random') return offer[Math.floor(rng() * 2)]!
  return FRIEND_VALUE[offer[0]] >= FRIEND_VALUE[offer[1]] ? offer[0] : offer[1]
}

function pickDungeon(
  offer: [DungeonPerkId, DungeonPerkId],
  mode: PickMode,
  rng: () => number,
): DungeonPerkId {
  if (mode === 'random') return offer[Math.floor(rng() * 2)]!
  return DUNGEON_VALUE[offer[0]] >= DUNGEON_VALUE[offer[1]] ? offer[0] : offer[1]
}

/** Build a 3-slot planned dungeon loadout with random or greedy picks. */
function planDungeon(seedRng: () => number, mode: PickMode): PlannedDungeonLoadout {
  if (mode === 'random') return rollPredefinedDungeonPerks(seedRng)
  let side = createEmptySideState<DungeonPerkId>()
  const picks: PlannedDungeonLoadout['picks'] = []
  for (let i = 0; i < PERK_SLOT_COUNT; i++) {
    const offer = rollOffer('dungeon', side.ranks, seedRng)
    if (!offer) break
    const id = pickDungeon(offer, 'smart', seedRng)
    side = selectPerk(side, id)
    const rank = side.ranks[id]
    if (rank) picks.push({ id, rank })
  }
  return { picks }
}

function applyFloorPerks(
  raid: RaidState,
  perks: PerksState,
  planned: PlannedDungeonLoadout,
  floor: number,
  rng: () => number,
  friendMode: PickMode,
): { raid: RaidState; perks: PerksState } {
  const offer = rollFriendOffer(perks, rng)
  let next = perks
  if (offer) {
    const pick = pickFriend(offer, friendMode, rng)
    next = selectFriendPerk(next, pick)
  }
  const slotIndex = Math.min(2, Math.max(0, floor - 1))
  next = {
    ...next,
    dungeon: revealDungeonPick(next.dungeon, planned, slotIndex),
  }
  return { raid: syncRaidWithPerks(raid, next), perks: next }
}

function playFloor(raid: RaidState): RaidState {
  let r = raid
  let ticks = 0
  while (r.phase === 'running' && ticks < MAX_TICKS_PER_FLOOR) {
    r = tickRaid(r)
    ticks++
  }
  if (r.phase === 'running') {
    r = { ...r, phase: 'dead' }
  }
  return r
}

function simulateOne(
  seed: number,
  friendMode: PickMode,
  dungeonMode: PickMode,
): RunLog {
  const perkRng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const bp: DungeonBlueprint = generateBlueprint(
    (seed * 1664525 + 1013904223) >>> 0,
    `Sim ${seed}`,
  )
  const planned = planDungeon(mulberry32((seed ^ 0xdeadbeef) >>> 0), dungeonMode)

  let perks = createEmptyPerksState()
  let raid = startRaid(bp, 1)
  let totalTicks = 0
  let floorsCleared = 0

  for (let floor = 1; floor <= 3; floor++) {
    const applied = applyFloorPerks(raid, perks, planned, floor, perkRng, friendMode)
    raid = applied.raid
    perks = applied.perks

    const beforeTicks = raid.tick
    raid = playFloor(raid)
    totalTicks += raid.tick - beforeTicks

    if (raid.phase === 'dead') {
      return {
        result: 'dead',
        floorsCleared,
        ticks: totalTicks,
        friendRanks: { ...perks.friend.ranks },
        dungeonRanks: { ...perks.dungeon.ranks },
      }
    }

    if (raid.phase === 'floorClear' || raid.phase === 'won') {
      floorsCleared++
      if (floor >= 3 || raid.phase === 'won') {
        return {
          result: 'won',
          floorsCleared,
          ticks: totalTicks,
          friendRanks: { ...perks.friend.ranks },
          dungeonRanks: { ...perks.dungeon.ranks },
        }
      }
      raid = advanceFloor(raid, bp)
      continue
    }

    return {
      result: 'dead',
      floorsCleared,
      ticks: totalTicks,
      friendRanks: { ...perks.friend.ranks },
      dungeonRanks: { ...perks.dungeon.ranks },
    }
  }

  return {
    result: floorsCleared >= 3 ? 'won' : 'dead',
    floorsCleared,
    ticks: totalTicks,
    friendRanks: { ...perks.friend.ranks },
    dungeonRanks: { ...perks.dungeon.ranks },
  }
}

function simulateCausal(
  seed: number,
  side: 'friend' | 'dungeon',
  id: PerkId,
  rank: 1 | 2 | 3,
): Result {
  const bp = generateBlueprint((seed * 1103515245 + 12345) >>> 0, `Causal ${id}`)
  let perks = createEmptyPerksState()
  if (side === 'friend') {
    perks = {
      ...perks,
      friend: {
        slots: [id as FriendPerkId, null, null],
        ranks: { [id]: rank } as Partial<Record<FriendPerkId, 1 | 2 | 3>>,
      },
    }
  } else {
    perks = {
      ...perks,
      dungeon: {
        slots: [id as DungeonPerkId, null, null],
        ranks: { [id]: rank } as Partial<Record<DungeonPerkId, 1 | 2 | 3>>,
      },
    }
  }

  let raid = syncRaidWithPerks(startRaid(bp, 1), perks)
  for (let floor = 1; floor <= 3; floor++) {
    raid = playFloor(raid)
    if (raid.phase === 'dead') return 'dead'
    if (raid.phase === 'floorClear' || raid.phase === 'won') {
      if (floor >= 3) return 'won'
      raid = advanceFloor(raid, bp)
      raid = syncRaidWithPerks(raid, perks)
      continue
    }
    return 'dead'
  }
  return 'won'
}

function summarizeMatchup(label: string, logs: RunLog[]) {
  const n = logs.length
  const wins = logs.filter((l) => l.result === 'won').length
  const losses = n - wins
  const p = wins / n
  const q = 1 - p
  // Geometric: dungeon wins before first Friend clear
  const expectedStreak = p > 0 ? q / p : Infinity
  const pSurvive15 = q ** 15
  const pSurvive20 = q ** 20
  const pReach50 = q ** 50

  console.log(`=== ${label} (${n} raids) ===`)
  console.log(`Friend win:   ${pct(wins, n)}  (${wins}/${n})`)
  console.log(`Dungeon win:  ${pct(losses, n)}  (${losses}/${n})`)
  console.log(`E[dungeon streak before clear]: ${expectedStreak.toFixed(1)}`)
  console.log(`P(survive 15 undefeated):       ${(100 * pSurvive15).toFixed(2)}%`)
  console.log(`P(survive 20 undefeated):       ${(100 * pSurvive20).toFixed(2)}%`)
  console.log(`P(reach 50 dungeon wins):       ${(100 * pReach50).toFixed(2)}%`)
  console.log('')
}

function runMatchup(friendMode: PickMode, dungeonMode: PickMode, seedBase: number): RunLog[] {
  const logs: RunLog[] = []
  for (let i = 0; i < RUNS; i++) {
    logs.push(simulateOne(seedBase + i * 9973, friendMode, dungeonMode))
  }
  return logs
}

function main() {
  const t0 = performance.now()

  const smartSmart = runMatchup('smart', 'smart', 0xc0ffee)
  const randomSmart = runMatchup('random', 'smart', 0xbadcafe)
  const randomRandom = runMatchup('random', 'random', 0xdeadbeef)

  console.log(`Elapsed: ${((performance.now() - t0) / 1000).toFixed(2)}s`)
  console.log('')
  console.log('Targets (reasonable = smart picks both sides):')
  console.log('  Friend ~5.5–6.5%  →  E[dungeon streak] 15–18,  P(50 wins) ≈ 5%')
  console.log('  (Note: “win every 3rd” = 33% conflicts with streak 15–20; streak math wins.)')
  console.log('')

  summarizeMatchup('REASONABLE Friend vs REASONABLE Dungeon', smartSmart)
  summarizeMatchup('RANDOM Friend vs REASONABLE Dungeon', randomSmart)
  summarizeMatchup('RANDOM Friend vs RANDOM Dungeon', randomRandom)

  // Causal probe (lighter)
  console.log(`--- Causal: single perk II, ${CAUSAL_N} runs ---`)
  let baselineWins = 0
  for (let i = 0; i < CAUSAL_N; i++) {
    const bp = generateBlueprint((0xb000 + i * 17) >>> 0, 'base')
    let raid = startRaid(bp, 1)
    let cleared = 0
    for (let f = 1; f <= 3; f++) {
      raid = playFloor(raid)
      if (raid.phase === 'dead') break
      if (raid.phase === 'floorClear' || raid.phase === 'won') {
        cleared++
        if (f < 3) raid = advanceFloor(raid, bp)
      }
    }
    if (cleared >= 3) baselineWins++
  }
  console.log(`Baseline no perks: Friend ${pct(baselineWins, CAUSAL_N)}`)
  for (const id of FRIEND_PERK_IDS) {
    let w = 0
    for (let i = 0; i < CAUSAL_N; i++) {
      if (simulateCausal(0xa0000000 + id.length * 1000 + i, 'friend', id, 2) === 'won') w++
    }
    console.log(`  Friend ${id.padEnd(15)} ${pct(w, CAUSAL_N)}`)
  }
  for (const id of DUNGEON_PERK_IDS) {
    let w = 0
    for (let i = 0; i < CAUSAL_N; i++) {
      if (simulateCausal(0xd0000000 + id.length * 1000 + i, 'dungeon', id, 2) === 'won') w++
    }
    console.log(`  Dungeon ${id.padEnd(14)} Friend ${pct(w, CAUSAL_N)} / Dungeon ${pct(CAUSAL_N - w, CAUSAL_N)}`)
  }
}

main()
