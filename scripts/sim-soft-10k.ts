/**
 * Soft ×10k — Friend vs Dungeon only (canonical close @1.5×).
 * Targets: Friend clear 30–35%, pot ~2–3× entry; Dungeon claim ~1.5× create.
 *
 *   npx tsx scripts/sim-soft-10k.ts
 * Writes: soft-10k-out.txt
 */
import { writeFileSync } from 'node:fs'
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

const N_LIVES = 10_000

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
function quantile(xs: number[], q: number) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))
  return s[i]!
}
function hist(xs: number[], edges: number[]): string[] {
  const lines: string[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i]!
    const hi = edges[i + 1]!
    const c = xs.filter((x) => x >= lo && x < hi).length
    lines.push(`  [${lo.toFixed(2)}, ${hi.toFixed(2)})  ${pct(c / Math.max(1, xs.length))}  n=${c}`)
  }
  const last = edges[edges.length - 1]!
  const cLast = xs.filter((x) => x >= last).length
  lines.push(`  [${last.toFixed(2)}, +inf)  ${pct(cLast / Math.max(1, xs.length))}  n=${cLast}`)
  return lines
}

function main() {
  const lines: string[] = []
  const log = (s = '') => {
    lines.push(s)
    console.log(s)
  }

  log(`SOFT × ${N_LIVES} dungeon lives — Friend vs Dungeon`)
  log(`Create $${SOFT.createCost} → bank $${SOFT.createToBank} | Entry $${SOFT.entryCost} → bank +$${SOFT.entryToBank}`)
  log(`Dungeon closes at suggested ${SOFT.suggestedCloseRoi}× (free claim, this is the Soft design policy)`)
  log(`Friend clear target 30–35% | Friend pot target ~2–3× entry | Dungeon claim target ~1.5× create`)
  log(`Combat ease: units=${SOFT.dungeonPowerScale} abs=${absoluteDungeonPowerScale('soft')} sta+${SOFT.friendStaminaBonus} fright-${SOFT.friendFrightCut}`)
  log('')

  let attempts = 0
  let friendClears = 0
  let dungeonClaims = 0
  let dungeonWiped = 0

  const friendPots: number[] = []
  const friendMults: number[] = []
  const dungeonPays: number[] = []
  const dungeonRois: number[] = [] // only when dungeon claims
  const dungeonRoiAll: number[] = [] // per life: claim/create or 0 if wiped
  const friendClearAtKills: number[] = []
  const dungeonClaimAtKills: number[] = []

  for (let d = 0; d < N_LIVES; d++) {
    let kills = 0
    let done = false
    while (!done && kills < SOFT.maxLiveWins) {
      attempts++
      const cleared = raidClears(0x51f70000 + d * 10007 + kills * 7919)
      if (cleared) {
        friendClears++
        const bank = softBankAfterKills(kills) + SOFT.entryToBank
        const pot = bank * SOFT.clearRaiderFrac
        friendPots.push(pot)
        friendMults.push(pot / SOFT.entryCost)
        friendClearAtKills.push(kills)
        dungeonWiped++
        dungeonRoiAll.push(0)
        done = true
        break
      }
      kills++
      const bank = softBankAfterKills(kills)
      if (softSuggestedClose(bank, kills, SOFT.suggestedCloseRoi)) {
        const pay = softClosePayout(bank, kills)
        dungeonClaims++
        dungeonPays.push(pay)
        dungeonRois.push(softRoi(pay))
        dungeonRoiAll.push(softRoi(pay))
        dungeonClaimAtKills.push(kills)
        done = true
      }
    }
    if (!done) {
      const bank = softBankAfterKills(kills)
      const pay = softClosePayout(bank, kills)
      dungeonClaims++
      dungeonPays.push(pay)
      dungeonRois.push(softRoi(pay))
      dungeonRoiAll.push(softRoi(pay))
      dungeonClaimAtKills.push(kills)
    }
  }

  const clearRate = friendClears / attempts
  const meanFriendMult = mean(friendMults)
  const meanDungeonRoiWhenClaim = mean(dungeonRois)
  const meanDungeonRoiAllLives = mean(dungeonRoiAll)

  log('══ Friend (raid attempts) ══')
  log(`  attempts              ${attempts}`)
  log(`  clear rate            ${pct(clearRate)}  (${friendClears}/${attempts})   target 30–35%`)
  log(`  mean pot if clear     $${mean(friendPots).toFixed(2)}`)
  log(`  mean × if clear       ${meanFriendMult.toFixed(2)}× entry   target ~2–3×`)
  log(`  pot × p50/p90         ${quantile(friendMults, 0.5).toFixed(2)}× / ${quantile(friendMults, 0.9).toFixed(2)}×`)
  log('  Friend × distribution:')
  for (const h of hist(friendMults, [0, 1.5, 2, 2.5, 3, 3.5, 4])) log(h)
  log('  clear happens at kills-before-this-raid:')
  for (let k = 0; k <= 5; k++) {
    const c = friendClearAtKills.filter((x) => x === k).length
    if (c) log(`    k=${k}: ${pct(c / Math.max(1, friendClears))}  n=${c}`)
  }

  log('')
  log('══ Dungeon (per Soft life, closes @1.5×) ══')
  log(`  lives                 ${N_LIVES}`)
  log(`  Friend takes bank     ${pct(dungeonWiped / N_LIVES)}  (${dungeonWiped})`)
  log(`  Dungeon claims        ${pct(dungeonClaims / N_LIVES)}  (${dungeonClaims})`)
  log(`  mean $ if claims      $${mean(dungeonPays).toFixed(2)}`)
  log(`  mean ROI if claims    ${meanDungeonRoiWhenClaim.toFixed(2)}× create   target ~1.5×`)
  log(`  mean ROI all lives    ${meanDungeonRoiAllLives.toFixed(2)}×  (wipes count as 0 bank claim)`)
  log(`  claim kills mean      ${mean(dungeonClaimAtKills).toFixed(2)}`)
  log('  Dungeon ROI (when claims) distribution:')
  for (const h of hist(dungeonRois, [0, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5])) log(h)

  log('')
  log('══ Target check ══')
  const okClear = clearRate >= 0.3 && clearRate <= 0.35
  const okFriendX = meanFriendMult >= 2 && meanFriendMult <= 3
  const okDungeonX =
    meanDungeonRoiWhenClaim >= 1.4 && meanDungeonRoiWhenClaim <= 1.7
  log(`  Friend clear 30–35%:     ${okClear ? 'OK' : 'OFF'}  (${pct(clearRate)})`)
  log(`  Friend mean × 2–3:       ${okFriendX ? 'OK' : 'OFF'}  (${meanFriendMult.toFixed(2)}×)`)
  log(`  Dungeon claim ~1.5×:     ${okDungeonX ? 'OK' : 'OFF'}  (${meanDungeonRoiWhenClaim.toFixed(2)}× when claims)`)
  if (meanDungeonRoiAllLives < 1.2) {
    log(
      `  NOTE: all-lives ROI ${meanDungeonRoiAllLives.toFixed(2)}× < 1.5 — wipes drag EV; 1.5× is the claim-size target, not EV incl. clears (shares not in this run).`,
    )
  }

  log('')
  log('(Hard create↔raid parity levers are separate WIP — see create-raid-parity rule.)')

  writeFileSync('soft-10k-out.txt', lines.join('\n'), 'utf8')
  console.log('\nWrote soft-10k-out.txt')
}

main()
