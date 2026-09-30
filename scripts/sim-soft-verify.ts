/**
 * Soft final verification: combat clear + owner ROI curve.
 *   npx tsx scripts/sim-soft-verify.ts
 */
import { generateBlueprint } from '../src/game/mapGen.ts'
import {
  SOFT,
  absoluteDungeonPowerScale,
  softBankAfterKills,
  softClosePayout,
  softRoi,
  softSuggestedClose,
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
    const id = DV[o[0]] >= DV[o[1]] ? o[0]! : o[1]!
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

function one(seed: number, friendSmart: boolean): boolean {
  const perkRng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const bp: DungeonBlueprint = {
    ...generateBlueprint((seed * 1664525 + 1013904223) >>> 0, 'v'),
    tier: 'soft',
    dungeonPowerScale: absoluteDungeonPowerScale('soft'),
  }
  const planned = plan(mulberry32((seed ^ 0xdeadbeef) >>> 0))
  let perks = createEmptyPerksState()
  let raid = startRaid(bp, 1)
  for (let floor = 1; floor <= 3; floor++) {
    const offer = rollFriendOffer(perks, perkRng)
    if (offer) {
      const id = friendSmart
        ? FV[offer[0]] >= FV[offer[1]]
          ? offer[0]!
          : offer[1]!
        : offer[Math.floor(perkRng() * 2)]!
      perks = selectFriendPerk(perks, id)
    }
    perks = { ...perks, dungeon: revealDungeonPick(perks.dungeon, planned, floor - 1) }
    raid = syncRaidWithPerks(raid, perks)
    raid = play(raid)
    if (raid.phase === 'dead') return false
    if (raid.phase === 'floorClear' || raid.phase === 'won') {
      if (floor >= 3 || raid.phase === 'won') return true
      raid = advanceFloor(raid, bp)
      continue
    }
    return false
  }
  return false
}

function ownerDist(clearP: number, closeRoi: number, n: number, seed: number) {
  const rng = mulberry32(seed)
  const buckets: Record<string, number> = {
    '0 (cleared)': 0,
    '0.75–1.24×': 0,
    '1.25–1.74×': 0,
    '1.75–2.24×': 0,
    '2.25–2.74×': 0,
    '2.75×+': 0,
  }
  let sum = 0
  let cleared = 0
  for (let i = 0; i < n; i++) {
    let kills = 0
    let payout = 0
    let done = false
    while (!done && kills < 20) {
      if (rng() < clearP) {
        cleared++
        payout = 0
        done = true
        break
      }
      kills++
      const bank = softBankAfterKills(kills)
      if (softSuggestedClose(bank, kills, closeRoi) || kills >= 12) {
        payout = softClosePayout(bank, kills)
        done = true
      }
    }
    const roi = softRoi(payout)
    sum += roi
    if (payout <= 0) buckets['0 (cleared)']!++
    else if (roi < 1.25) buckets['0.75–1.24×']!++
    else if (roi < 1.75) buckets['1.25–1.74×']!++
    else if (roi < 2.25) buckets['1.75–2.24×']!++
    else if (roi < 2.75) buckets['2.25–2.74×']!++
    else buckets['2.75×+']!++
  }
  return { mean: sum / n, cleared: cleared / n, buckets }
}

function pct(x: number) {
  return `${(100 * x).toFixed(1)}%`
}

let smartWins = 0
const N = 5000
for (let i = 0; i < N; i++) if (one(0x51f70000 + i * 9973, true)) smartWins++
let randWins = 0
const NR = 2000
for (let i = 0; i < NR; i++) if (one(0x51f80000 + i * 9973, false)) randWins++

const clearP = smartWins / N
console.log('SOFT constants', {
  scale: absoluteDungeonPowerScale('soft'),
  sta: SOFT.friendStaminaBonus,
  fright: SOFT.friendFrightCut,
  dodge: SOFT.friendDodgeFloor,
})
console.log(`Friend clear smart ${pct(clearP)} (${smartWins}/${N})`)
console.log(`Friend clear random ${pct(randWins / NR)} (${randWins}/${NR})`)

console.log('\nOwner policies @ measured clear p:')
for (const t of [1.3, 1.5, 1.7, 2.0, 2.5]) {
  const d = ownerDist(clearP, t, 20000, 0xe200 + Math.floor(t * 10))
  console.log(
    `close@${t}× meanROI=${d.mean.toFixed(2)}× dungeonCleared=${pct(d.cleared)} peakBand=${Object.entries(d.buckets).sort((a, b) => b[1] - a[1])[0]![0]}`,
  )
}

const early = ownerDist(clearP, 1.5, 30000, 0xd150)
const greedy = ownerDist(clearP, 2.5, 30000, 0xd250)
console.log('\nDistribution close@1.5× (30k):')
for (const [k, v] of Object.entries(early.buckets)) console.log(`  ${k.padEnd(14)} ${pct(v / 30000)}`)
console.log(
  `early mean ${early.mean.toFixed(3)}× vs greedy ${greedy.mean.toFixed(3)}× → early better? ${early.mean > greedy.mean}`,
)

// Among successful closes only — mode should be ~1.5
const success = 30000 - early.buckets['0 (cleared)']!
console.log(
  `Among successful closes: share in 1.25–1.74× = ${pct(early.buckets['1.25–1.74×']! / Math.max(1, success))}`,
)
