/**
 * Hard ×1000 raid attempts — death by floor + clear %.
 * Hard = old combat rules + HARD_FLOOR_STAMINA only (F1=20 → lower).
 * Target curve (cumulative): die F1 ~30%, by F2 ~60%, by F3 ~90%, clear ~10%.
 *
 *   npx tsx scripts/sim-hard-floors-1k.ts
 */
import { writeFileSync } from 'node:fs'
import { generateBlueprint } from '../src/game/mapGen.ts'
import {
  HARD,
  SOFT,
  HARD_FLOOR_STAMINA,
  SOFT_FLOOR_STAMINA,
  absoluteDungeonPowerScale,
} from '../src/game/economy.ts'
import {
  createEmptyPerksState,
  createEmptySideState,
  revealDungeonPick,
  rollFriendOffer,
  rollOffer,
  selectFriendPerk,
  selectPerk,
  syncRaidWithPerks,
  type DungeonPerkId,
  type FriendPerkId,
} from '../src/game/perks/index.ts'
import { advanceFloor, startRaid, tickRaid } from '../src/game/raid.ts'
import { mulberry32 } from '../src/game/rng.ts'
import type { DungeonBlueprint, RaidState } from '../src/game/types.ts'

const N = 1000
const FV: Record<FriendPerkId, number> = {
  dash: 100,
  fearless: 92,
  sharpEye: 90,
  endurance: 85,
  rally: 84,
  dodge: 70,
}
const DV: Record<DungeonPerkId, number> = {
  horde: 100,
  dreadfulBeasts: 92,
  fog: 88,
  walls: 85,
  thickHide: 82,
  sharpClaws: 78,
}

function plan(rng: () => number) {
  let side = createEmptySideState<DungeonPerkId>()
  const picks: { id: DungeonPerkId; rank: 1 | 2 | 3 }[] = []
  for (let i = 0; i < 3; i++) {
    const o = rollOffer('dungeon', side.ranks, rng)
    if (!o) break
    const id = DV[o[0]!] >= DV[o[1]!] ? o[0]! : o[1]!
    side = selectPerk(side, id)
    const rank = side.ranks[id]
    if (rank) picks.push({ id, rank })
  }
  return { picks }
}

function play(r: RaidState): RaidState {
  let t = 0
  while (r.phase === 'running' && t++ < 600) r = tickRaid(r)
  return r.phase === 'running' ? { ...r, phase: 'dead' } : r
}

type FloorOut = 'die1' | 'die2' | 'die3' | 'clear'

function oneRaid(seed: number, tier: 'soft' | 'hard'): FloorOut {
  const perkRng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const bp: DungeonBlueprint = {
    ...generateBlueprint((seed * 1664525 + 1013904223) >>> 0, tier === 'hard' ? 'h' : 's'),
    tier,
    dungeonPowerScale: absoluteDungeonPowerScale(tier),
  }
  const planned = plan(mulberry32((seed ^ 0xdeadbeef) >>> 0))
  let perks = createEmptyPerksState()
  let raid = startRaid(bp, 1)
  for (let floor = 1; floor <= 3; floor++) {
    const offer = rollFriendOffer(perks, perkRng)
    if (offer) {
      const id = FV[offer[0]!] >= FV[offer[1]!] ? offer[0]! : offer[1]!
      perks = selectFriendPerk(perks, id)
    }
    perks = { ...perks, dungeon: revealDungeonPick(perks.dungeon, planned, floor - 1) }
    raid = syncRaidWithPerks(raid, perks)
    raid = play(raid)
    if (raid.phase === 'dead') {
      if (floor === 1) return 'die1'
      if (floor === 2) return 'die2'
      return 'die3'
    }
    if (raid.phase === 'floorClear' || raid.phase === 'won') {
      if (floor >= 3 || raid.phase === 'won') return 'clear'
      raid = advanceFloor(raid, bp)
      continue
    }
    if (floor === 1) return 'die1'
    if (floor === 2) return 'die2'
    return 'die3'
  }
  return 'die3'
}

function pct(x: number) {
  return `${(100 * x).toFixed(1)}%`
}

function runTier(tier: 'soft' | 'hard', seedBase: number) {
  let die1 = 0,
    die2 = 0,
    die3 = 0,
    clear = 0
  for (let i = 0; i < N; i++) {
    const o = oneRaid(seedBase + i * 7919, tier)
    if (o === 'die1') die1++
    else if (o === 'die2') die2++
    else if (o === 'die3') die3++
    else clear++
  }
  const reach2 = N - die1
  const reach3 = reach2 - die2
  return {
    die1,
    die2,
    die3,
    clear,
    cum1: die1 / N,
    cum2: (die1 + die2) / N,
    cum3: (die1 + die2 + die3) / N,
    clearP: clear / N,
    cond2: reach2 ? die2 / reach2 : 0,
    cond3: reach3 ? die3 / reach3 : 0,
  }
}

function main() {
  const lines: string[] = []
  const log = (s = '') => {
    lines.push(s)
    console.log(s)
  }
  log(`Floor curve ×${N} (Soft STA↓to20 · Hard STA-by-floor)`)
  log(
    `HARD abs=${absoluteDungeonPowerScale('hard')} STA [${HARD_FLOOR_STAMINA[1]}, ${HARD_FLOOR_STAMINA[2]}, ${HARD_FLOOR_STAMINA[3]}]`,
  )
  log(
    `SOFT STA [${SOFT_FLOOR_STAMINA[1]}, ${SOFT_FLOOR_STAMINA[2]}, ${SOFT_FLOOR_STAMINA[3]}] abs=${absoluteDungeonPowerScale('soft')} eff×${SOFT.dungeonEfficacy} fright−${SOFT.friendFrightCut}`,
  )
  log('Target Soft: F1 almost all pass → clear ~33%')
  log('Target Hard cum: die1~30% · byF2~60% · byF3~90% · clear~10%\n')

  for (const tier of ['hard', 'soft'] as const) {
    const r = runTier(tier, tier === 'hard' ? 0x4a7d0000 : 0x50f70000)
    log(`══ ${tier.toUpperCase()} ══`)
    log(`  die F1 ${r.die1}  ${pct(r.cum1)}  (cum)`)
    log(`  die F2 ${r.die2}  ${pct(r.die2 / N)}  cum by F2 ${pct(r.cum2)}  | cond|reach2 ${pct(r.cond2)}`)
    log(`  die F3 ${r.die3}  ${pct(r.die3 / N)}  cum by F3 ${pct(r.cum3)}  | cond|reach3 ${pct(r.cond3)}`)
    log(`  CLEAR  ${r.clear}  ${pct(r.clearP)}`)
    log('')
  }

  writeFileSync('hard-floors-1k-out.txt', lines.join('\n'), 'utf8')
  log('Wrote hard-floors-1k-out.txt')
}

main()
