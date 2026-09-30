/**
 * Hard combat + owner ROI (bank + pool shares). 1000 sims, tune, 1000 more.
 *
 * Targets:
 * - Friend clear ≈ 10–11% (every 9–10) with smart picks
 * - Soft clear still >> Hard
 * - Owner total ROI (claim + shares) ≈ 2–2.5× if closes near 2× bank / holds for pool
 * - Rerolls (+50% each) → reward pool; 80% hard / 20% soft drip
 *
 *   npx tsx scripts/sim-hard.ts
 */
import { generateBlueprint } from '../src/game/mapGen.ts'
import {
  HARD,
  SOFT,
  absoluteDungeonPowerScale,
  distributePoolEpoch,
  hardBankAfterKills,
  hardClosePayout,
  hardRoi,
  hardSuggestedClose,
  rerollCostSum,
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
  type PlannedDungeonLoadout,
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

type Ease = { scale: number; sta: number; fright: number }

function planDungeon(rng: () => number, smart: boolean): PlannedDungeonLoadout {
  let side = createEmptySideState<DungeonPerkId>()
  const picks: PlannedDungeonLoadout['picks'] = []
  for (let i = 0; i < 3; i++) {
    const o = rollOffer('dungeon', side.ranks, rng)
    if (!o) break
    const id = smart
      ? DV[o[0]] >= DV[o[1]]
        ? o[0]!
        : o[1]!
      : o[Math.floor(rng() * 2)]!
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

function oneRaid(seed: number, ease: Ease, friendSmart: boolean, tier: 'soft' | 'hard' = 'hard'): boolean {
  const perkRng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const scale = tier === 'soft' ? absoluteDungeonPowerScale('soft') : ease.scale
  const bp: DungeonBlueprint = {
    ...generateBlueprint((seed * 1664525 + 1013904223) >>> 0, tier === 'soft' ? 's' : 'h'),
    tier,
    dungeonPowerScale: scale,
  }
  const planned = planDungeon(mulberry32((seed ^ 0xdeadbeef) >>> 0), true)
  let perks = createEmptyPerksState()
  let raid = startRaid(bp, 1)
  const softEase =
    tier === 'soft'
      ? {
          staminaBonus: SOFT.friendStaminaBonus,
          frightCut: SOFT.friendFrightCut,
          dodgeFloor: SOFT.friendDodgeFloor,
        }
      : ease.sta || ease.fright
        ? { staminaBonus: ease.sta, frightCut: ease.fright, dodgeFloor: 0 }
        : undefined
  raid = {
    ...raid,
    tier,
    dungeonPowerScale: scale,
    softEase,
  }
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
      raid = { ...raid, tier, dungeonPowerScale: scale, softEase }
      continue
    }
    return false
  }
  return false
}

function clearRate(ease: Ease, n: number, seed: number, smart: boolean, tier: 'soft' | 'hard' = 'hard') {
  let w = 0
  for (let i = 0; i < n; i++) if (oneRaid(seed + i * 9973, ease, smart, tier)) w++
  return w / n
}

/**
 * Owner world: 4 Soft + 4 Hard live fillers; track one Hard owner dungeon.
 * Each raid = 1 minute epoch drip of that raid's pool contribution.
 */
function ownerSim(
  clearP: number,
  n: number,
  seed: number,
  closeBankRoi: number,
  opts: {
    meanCreateRerolls: number
    meanFriendRerolls: number
    liveSoft: number
    liveHard: number
  },
) {
  const rng = mulberry32(seed)
  let sumRoi = 0
  let sumShares = 0
  let sumClaim = 0
  let cleared = 0
  let sumPool = 0
  let sumKills = 0
  const roiBands = { '0': 0, '1-1.5': 0, '1.5-2': 0, '2-2.5': 0, '2.5-3': 0, '3+': 0 }

  for (let d = 0; d < n; d++) {
    const createRerolls = Math.max(0, Math.round(opts.meanCreateRerolls + (rng() - 0.5) * 2))
    const createReroll$ = rerollCostSum(createRerolls)
    let poolEpoch = createReroll$ // create rerolls enter pool immediately
    let shares = 0
    let kills = 0
    let claim = 0
    let done = false

    // drip create rerolls once
    {
      const drip = distributePoolEpoch(poolEpoch, opts.liveSoft, opts.liveHard)
      shares += drip.hardPerDungeon
      sumPool += poolEpoch
      poolEpoch = 0
    }

    while (!done && kills < HARD.maxLiveWins) {
      const friendRerolls = Math.max(0, Math.round(opts.meanFriendRerolls + (rng() - 0.4) * 2))
      const friendReroll$ = rerollCostSum(friendRerolls)
      const poolAdd = HARD.entryToOwnerPool + friendReroll$
      sumPool += poolAdd

      if (rng() < clearP) {
        cleared++
        claim = 0
        done = true
        // still drip this raid's pool before dungeon dies
        const drip = distributePoolEpoch(poolAdd, opts.liveSoft, opts.liveHard)
        shares += drip.hardPerDungeon
        break
      }

      kills++
      const bank = hardBankAfterKills(kills)
      const drip = distributePoolEpoch(poolAdd, opts.liveSoft, opts.liveHard)
      shares += drip.hardPerDungeon

      if (hardSuggestedClose(bank, kills, closeBankRoi)) {
        claim = hardClosePayout(bank, kills)
        done = true
      }
    }
    if (!done) {
      claim = hardClosePayout(hardBankAfterKills(kills), kills)
    }

    const invested = HARD.createCost + createReroll$
    const total = claim + shares
    const roi = hardRoi(total, invested)
    sumRoi += roi
    sumShares += shares
    sumClaim += claim
    sumKills += kills
    if (roi <= 0) roiBands['0']++
    else if (roi < 1.5) roiBands['1-1.5']++
    else if (roi < 2) roiBands['1.5-2']++
    else if (roi < 2.5) roiBands['2-2.5']++
    else if (roi < 3) roiBands['2.5-3']++
    else roiBands['3+']++
  }

  return {
    meanRoi: sumRoi / n,
    meanShares: sumShares / n,
    meanClaim: sumClaim / n,
    clearRate: cleared / n,
    meanKills: sumKills / n,
    meanPoolPerDungeonLife: sumPool / n,
    roiBands,
  }
}

function pct(x: number) {
  return `${(100 * x).toFixed(1)}%`
}

function main() {
  console.log('=== HARD combat sweep (1000 each) → target clear 10–11% ===')
  const cands: Ease[] = [
    { scale: 1, sta: 0, fright: 0 },
    { scale: 0.95, sta: 0, fright: 0 },
    { scale: 0.92, sta: 0, fright: 0 },
    { scale: 0.9, sta: 0, fright: 0 },
    { scale: 0.88, sta: 1, fright: 0 },
    { scale: 0.85, sta: 0, fright: 5 },
    { scale: 0.85, sta: 1, fright: 5 },
  ]
  let best = cands[0]!
  let bestDist = 99
  for (const e of cands) {
    const p = clearRate(e, 1000, 0x4a7d0000 + Math.floor(e.scale * 1000) + e.sta * 17, true)
    const dist = Math.abs(p - HARD.targetClearP)
    console.log(`  scale=${e.scale} sta+${e.sta} fr+${e.fright} → clear=${pct(p)}`)
    if (dist < bestDist) {
      bestDist = dist
      best = e
    }
  }

  console.log('\n=== Confirm best 1000 ===')
  const p1 = clearRate(best, 1000, 0x4a7d1001, true)
  console.log(`chosen`, best, `clear=${pct(p1)}`)

  // If off target, nudge and second 1000
  let finalEase = best
  let finalP = p1
  if (Math.abs(p1 - HARD.targetClearP) > 0.025) {
    const nudge =
      p1 < HARD.targetClearP
        ? { ...best, scale: Math.max(0.7, best.scale - 0.05), sta: best.sta + 1 }
        : { ...best, scale: Math.min(1.05, best.scale + 0.05), fright: best.fright }
    console.log('\n=== Retune + 1000 ===', nudge)
    finalEase = nudge
    finalP = clearRate(nudge, 1000, 0x4a7d2002, true)
    console.log(`retuned clear=${pct(finalP)}`)
  }

  // Soft hierarchy check (cheap 400)
  const softP = clearRate({ scale: 1, sta: 0, fright: 0 }, 400, 0x50f70001, true, 'soft')
  console.log(`\nSoft clear (400) ${pct(softP)} > Hard ${pct(finalP)} ? ${softP > finalP}`)

  const liveSoft = 3
  const liveHard = 2
  for (const closeRoi of [1.6, 1.8, 2.0]) {
    const o = ownerSim(finalP, 1000, 0xe4a10000 + Math.floor(closeRoi * 100), closeRoi, {
      meanCreateRerolls: 2,
      meanFriendRerolls: 1.5,
      liveSoft,
      liveHard,
    })
    console.log(
      `closeBank@${closeRoi}× meanTotalROI=${o.meanRoi.toFixed(2)}× claim$${o.meanClaim.toFixed(1)} shares$${o.meanShares.toFixed(1)} kills=${o.meanKills.toFixed(1)} dungeonCleared=${pct(o.clearRate)} pool$/life=${o.meanPoolPerDungeonLife.toFixed(1)}`,
    )
    console.log('  bands', o.roiBands)
  }

  const o2 = ownerSim(finalP, 1000, 0xe4a20001, 1.8, {
    meanCreateRerolls: 2,
    meanFriendRerolls: 1.5,
    liveSoft,
    liveHard,
  })
  console.log('\n=== Pool volume sketch (per Hard life) ===')
  console.log(`mean pool inflow/life $${o2.meanPoolPerDungeonLife.toFixed(1)}`)
  console.log(`liveSoft=${liveSoft} liveHard=${liveHard} → each Hard gets 80%/2 of epoch pot`)
  console.log(`reroll: $1 → $1.5 → $2.25 → …`)
  console.log(`meanTotalROI@1.8 close=${o2.meanRoi.toFixed(2)}× (target ~2+)`)

  // Second 1000 combat confirm with FINAL ease constants from economy
  console.log('\n=== Final combat 1000 (HARD consts) ===')
  const pFinal = clearRate(
    {
      scale: absoluteDungeonPowerScale('hard'),
      sta: HARD.friendStaminaBonus,
      fright: HARD.friendFrightCut,
    },
    1000,
    0x4a7d3003,
    true,
  )
  console.log(`HARD consts clear=${pct(pFinal)} (want ~10–11%)`)
}

main()
