/**
 * Hard ×1000 dungeon lives: who wins + mean $ when they win.
 * Owner closes at suggested ~2.0× bank after minWins 7. Smart Friend picks. No pool shares.
 *
 *   npx tsx scripts/sim-hard-1k.ts
 */
import { generateBlueprint } from '../src/game/mapGen.ts'
import {
  HARD,
  absoluteDungeonPowerScale,
  hardBankAfterKills,
  hardClosePayout,
  hardSuggestedClose,
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

/** One Hard raid attempt. true = Friend cleared all 3 floors. */
function raidClears(seed: number): boolean {
  const perkRng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const bp: DungeonBlueprint = {
    ...generateBlueprint((seed * 1664525 + 1013904223) >>> 0, 'h'),
    tier: 'hard',
    dungeonPowerScale: absoluteDungeonPowerScale('hard'),
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
  console.log('HARD ×', N, 'dungeon lives')
  console.log('Create $' + HARD.createCost, '→ bank $' + HARD.createToBank + ' + fee $' + HARD.createFee)
  console.log('Entry $' + HARD.entryCost, '→ bank +$' + HARD.entryToBank + ' + pool $' + HARD.entryToOwnerPool)
  console.log(
    'Owner closes @ suggested',
    HARD.suggestedCloseRoi + '× after minWins',
    HARD.minWinsBeforeClaim,
    '(bank claim 95%)',
  )
  console.log('Raider clear = 95% of bank. Smart Friend picks. No pool shares / no Friend rerolls.\n')

  let ownerWins = 0
  let raiderWins = 0
  let attempts = 0
  let attemptClears = 0
  const ownerPays: number[] = []
  const raiderPays: number[] = []
  const ownerRoi: number[] = []
  const killHist = Array(41).fill(0)

  for (let d = 0; d < N; d++) {
    let kills = 0
    let done = false
    while (!done && kills < HARD.maxLiveWins) {
      attempts++
      const cleared = raidClears(0x4a7d0000 + d * 10007 + kills * 7919)
      if (cleared) {
        attemptClears++
        const bank = hardBankAfterKills(kills) + HARD.entryToBank
        const pot = bank * HARD.clearRaiderFrac
        raiderWins++
        raiderPays.push(pot)
        done = true
        break
      }
      kills++
      const bank = hardBankAfterKills(kills)
      if (hardSuggestedClose(bank, kills, HARD.suggestedCloseRoi)) {
        const pay = hardClosePayout(bank, kills)
        ownerWins++
        ownerPays.push(pay)
        ownerRoi.push(pay / HARD.createCost)
        killHist[Math.min(kills, 40)]++
        done = true
      }
    }
    if (!done) {
      const bank = hardBankAfterKills(kills)
      const pay = hardClosePayout(bank, kills)
      ownerWins++
      ownerPays.push(pay)
      ownerRoi.push(pay / HARD.createCost)
      killHist[Math.min(kills, 40)]++
    }
  }

  console.log('══ Per raid attempt ══')
  console.log('  attempts', attempts)
  console.log('  Friend clear rate', pct(attemptClears / attempts), `(${attemptClears}/${attempts})`)
  console.log('  Dungeon survive rate', pct(1 - attemptClears / attempts))

  console.log('\n══ Per Hard dungeon life (who takes the pot) ══')
  console.log('  Friend wins (clear)', pct(raiderWins / N), `(${raiderWins}/${N})`)
  console.log('  Dungeon wins (claim)', pct(ownerWins / N), `(${ownerWins}/${N})`)

  console.log('\n══ Mean $ when that side wins ══')
  console.log(
    '  Dungeon claim mean $' + mean(ownerPays).toFixed(2),
    `(ROI ${mean(ownerRoi).toFixed(2)}× on $${HARD.createCost} create)`,
  )
  console.log(
    '  Friend pot mean $' + mean(raiderPays).toFixed(2),
    `(${(mean(raiderPays) / HARD.entryCost).toFixed(2)}× on $${HARD.entryCost} entry)`,
  )

  console.log('\n══ Dungeon close kills (when dungeon wins) ══')
  for (let k = 0; k <= 40; k++) {
    if (killHist[k]) console.log(`  k=${k}: ${pct(killHist[k] / Math.max(1, ownerWins))} (${killHist[k]})`)
  }

  console.log('\n══ Note (parity WIP) ══')
  console.log('  Entry at full $10 (mul=1). Create↔raid discount levers: npm run sim:parity:behavior')
}

main()
