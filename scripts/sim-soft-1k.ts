/**
 * Soft ×1000 dungeon lives: who wins + mean $ when they win.
 * Owner closes at suggested ~1.5× bank. Smart Friend picks.
 *
 *   npx tsx scripts/sim-soft-1k.ts
 */
import { generateBlueprint } from '../src/game/mapGen.ts'
import {
  SOFT,
  absoluteDungeonPowerScale,
  softBankAfterKills,
  softClosePayout,
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

/** One Soft raid attempt. true = Friend cleared all 3 floors. */
function raidClears(seed: number): boolean {
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
      const id = FV[offer[0]!] >= FV[offer[1]!] ? offer[0]! : offer[1]!
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

function pct(x: number) {
  return `${(100 * x).toFixed(1)}%`
}

function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function main() {
  console.log('SOFT ×', N, 'dungeon lives')
  console.log('Create $' + SOFT.createCost, '→ bank $' + SOFT.createToBank)
  console.log('Entry $' + SOFT.entryCost, '→ bank +$' + SOFT.entryToBank)
  console.log('Owner closes @ suggested', SOFT.suggestedCloseRoi + '× (bank claim 95%)')
  console.log('Raider clear = 95% of bank. Smart Friend picks. No pool shares in this run.\n')

  let ownerWins = 0
  let raiderWins = 0
  let attempts = 0
  let attemptClears = 0
  const ownerPays: number[] = []
  const raiderPays: number[] = []
  const ownerRoi: number[] = []
  const killHist = Array(13).fill(0)

  for (let d = 0; d < N; d++) {
    let kills = 0
    let done = false
    while (!done && kills < SOFT.maxLiveWins) {
      attempts++
      const cleared = raidClears(0x51f70000 + d * 10007 + kills * 7919)
      if (cleared) {
        attemptClears++
        // Entry already in bank when raid starts
        const bank = softBankAfterKills(kills) + SOFT.entryToBank
        const pot = bank * SOFT.clearRaiderFrac
        raiderWins++
        raiderPays.push(pot)
        done = true
        break
      }
      kills++
      const bank = softBankAfterKills(kills)
      if (softSuggestedClose(bank, kills, SOFT.suggestedCloseRoi)) {
        const pay = softClosePayout(bank, kills)
        ownerWins++
        ownerPays.push(pay)
        ownerRoi.push(pay / SOFT.createCost)
        killHist[Math.min(kills, 12)]++
        done = true
      }
    }
    if (!done) {
      const bank = softBankAfterKills(kills)
      const pay = softClosePayout(bank, kills)
      ownerWins++
      ownerPays.push(pay)
      ownerRoi.push(pay / SOFT.createCost)
      killHist[Math.min(kills, 12)]++
    }
  }

  console.log('══ Per raid attempt ══')
  console.log('  attempts', attempts)
  console.log('  Friend clear rate', pct(attemptClears / attempts), `(${attemptClears}/${attempts})`)

  console.log('\n══ Per Soft dungeon life (who takes the pot) ══')
  console.log('  Raider wins (clear)', pct(raiderWins / N), `(${raiderWins}/${N})`)
  console.log('  Owner wins (claim)', pct(ownerWins / N), `(${ownerWins}/${N})`)

  console.log('\n══ Mean $ when that side wins ══')
  console.log(
    '  Owner claim mean $' + mean(ownerPays).toFixed(2),
    `(ROI ${mean(ownerRoi).toFixed(2)}× on $${SOFT.createCost} create)`,
  )
  console.log(
    '  Raider pot mean $' + mean(raiderPays).toFixed(2),
    `(${(mean(raiderPays) / SOFT.entryCost).toFixed(2)}× on $${SOFT.entryCost} entry)`,
  )

  console.log('\n══ Owner close kills (when owner wins) ══')
  for (let k = 0; k <= 12; k++) {
    if (killHist[k]) console.log(`  k=${k}: ${pct(killHist[k] / Math.max(1, ownerWins))} (${killHist[k]})`)
  }

  console.log('\n══ Note (parity WIP) ══')
  console.log('  Soft has no dynamic entry pricing. Create↔raid parity levers are Hard-only for now')
  console.log('  (see .cursor/rules/create-raid-parity.mdc).')
}

main()
