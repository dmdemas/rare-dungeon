/**
 * Parity stress: create-glut vs raid-glut (1000 Hard lives each).
 * Parity pricing is WIP — this finds when Soft/Hard OR outcomes break.
 *
 * npx tsx scripts/sim-parity-skew.ts
 */
import {
  HARD,
  distributePoolEpoch,
  hardClosePayout,
  hardRaiderClearPayout,
  hardRoi,
  rerollCostSum,
} from '../src/game/economy.ts'

const N = 1000
const CLEAR_P = HARD.targetClearP // ~0.11

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Skew = {
  name: string
  /** Live Hard dungeons competing for pool + raids. */
  liveHard: number
  liveSoft: number
  /**
   * Expected raids that land on THIS dungeon per “tick”.
   * Create-glut → low arrival; raid-glut → high arrival.
   * Modeled as: each loop iteration = one raid attempt (always);
   * maxAttempts before owner force-quit / abandon thin bank.
   */
  maxAttempts: number
  /** Owner closes when bank ROI ≥ this (after minWins). */
  closeRoi: number
  meanCreateRerolls: number
  meanFriendRerolls: number
  /** Multiplier on HARD.createCost (e.g. 1.25 create-tax). */
  createCostMul: number
  /**
   * Probability owner is a “holder” (closeRoi=99) chasing pool —
   * create-glut: few holders (banks starve); raid-glut: more holders hope for shares.
   */
  holdFrac: number
}

type Agg = {
  ownerRoi: number
  ownerShares: number
  ownerClaim: number
  ownerInvested: number
  wipe: number
  mid: number // 2–2.5×
  hi: number // ≥2.5×
  low: number
  kills: number
  attempts: number
  raiderSpend: number
  raiderWon: number
  clearPots: number[]
  m810: number
  poolIn: number
}

function bankAfter(kills: number) {
  return HARD.createToBank + kills * HARD.entryToBank
}

function runSkew(s: Skew, seed: number): Agg {
  const rng = mulberry32(seed)
  const a: Agg = {
    ownerRoi: 0,
    ownerShares: 0,
    ownerClaim: 0,
    ownerInvested: 0,
    wipe: 0,
    mid: 0,
    hi: 0,
    low: 0,
    kills: 0,
    attempts: 0,
    raiderSpend: 0,
    raiderWon: 0,
    clearPots: [],
    m810: 0,
    poolIn: 0,
  }

  const createCost = HARD.createCost * s.createCostMul

  for (let d = 0; d < N; d++) {
    const hold = rng() < s.holdFrac
    const closeRoi = hold ? 99 : s.closeRoi
    const cr = Math.max(0, Math.round(s.meanCreateRerolls + (rng() - 0.5) * 2))
    const cr$ = rerollCostSum(cr)
    const invested = createCost + cr$
    let shares = 0
    let poolEpoch = cr$
    a.poolIn += cr$
    // create rerolls drip once into live market
    {
      const drip = distributePoolEpoch(poolEpoch, s.liveSoft, s.liveHard)
      shares += drip.hardPerDungeon
    }

    let kills = 0
    let claim = 0
    let wiped = false
    let attempts = 0

    while (attempts < s.maxAttempts && kills < HARD.maxLiveWins) {
      const fr = Math.max(0, Math.round(s.meanFriendRerolls + (rng() - 0.4) * 2))
      const fr$ = rerollCostSum(fr)
      attempts++
      a.attempts++
      a.raiderSpend += HARD.entryCost + fr$
      const poolAdd = HARD.entryToOwnerPool + fr$
      a.poolIn += poolAdd

      if (rng() < CLEAR_P) {
        const bank = bankAfter(kills) + HARD.entryToBank
        const pot = hardRaiderClearPayout(bank)
        a.raiderWon += pot
        const m = pot / HARD.entryCost
        a.clearPots.push(m)
        if (m >= 8 && m <= 10.5) a.m810++
        wiped = true
        const drip = distributePoolEpoch(poolAdd, s.liveSoft, s.liveHard)
        shares += drip.hardPerDungeon
        break
      }

      kills++
      const drip = distributePoolEpoch(poolAdd, s.liveSoft, s.liveHard)
      shares += drip.hardPerDungeon

      const bank = bankAfter(kills)
      const pay = hardClosePayout(bank, kills)
      if (kills >= HARD.minWinsBeforeClaim && hardRoi(pay, createCost) >= closeRoi - 0.02) {
        // note: ROI vs createCost only (bank claim); shares separate — matches hardSuggestedClose spirit
        claim = pay
        break
      }
    }

    if (!wiped && !claim) {
      // starved or hit maxAttempts: claim whatever bank exists (may be below minWins → 0 protocol)
      claim = hardClosePayout(bankAfter(kills), kills)
    }

    const total = claim + shares
    const roi = hardRoi(total, invested)
    a.ownerRoi += roi
    a.ownerShares += shares
    a.ownerClaim += claim
    a.ownerInvested += invested
    a.kills += kills
    if (wiped) a.wipe++
    else if (roi >= 2 && roi < 2.5) a.mid++
    else if (roi >= 2.5) a.hi++
    else a.low++
  }
  return a
}

function pct(x: number) {
  return (100 * x).toFixed(1) + '%'
}

function mean(xs: number[]) {
  if (!xs.length) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function report(s: Skew, a: Agg) {
  const meanPot = mean(a.clearPots)
  const raiderEv = (a.raiderWon - a.raiderSpend) / Math.max(1, a.attempts)
  const ownerMean = a.ownerRoi / N
  const okOwner = a.mid / N + a.hi / N
  const okWipe810 = a.clearPots.length ? a.m810 / a.clearPots.length : 0

  console.log('\n══ ' + s.name + ' ══')
  console.log(
    ` liveHard=${s.liveHard} liveSoft=${s.liveSoft} maxAttempts=${s.maxAttempts}`,
    `create×${s.createCostMul} holdFrac=${s.holdFrac} close@${s.closeRoi}`,
  )
  console.log(
    ` owner meanROI ${ownerMean.toFixed(2)}×`,
    `| claim$${ (a.ownerClaim / N).toFixed(1)} shares$${(a.ownerShares / N).toFixed(1)}`,
    `| invest$${(a.ownerInvested / N).toFixed(1)}`,
  )
  console.log(
    ` owner bands: wipe ${pct(a.wipe / N)} | 2–2.5 ${pct(a.mid / N)} | 2.5+ ${pct(a.hi / N)} | low ${pct(a.low / N)}`,
  )
  console.log(
    ` mean kills ${ (a.kills / N).toFixed(1)}`,
    `| raider EV/att $${raiderEv.toFixed(3)}`,
    `| clear pot mean ${meanPot.toFixed(2)}×`,
    `| of clears in 8–10.5: ${pct(okWipe810)}`,
  )
  console.log(` pool inflow/life $${(a.poolIn / N).toFixed(1)}`)

  // Break detectors vs design OR
  const breaks: string[] = []
  if (ownerMean < 1.2 && a.wipe / N < 0.5) breaks.push('OWNER_STARVE (ROI<<2, few wipes)')
  if (ownerMean > 3.5) breaks.push('OWNER_TOO_JUICY (>3.5×)')
  if (okOwner < 0.15 && a.wipe / N < 0.4) breaks.push('OWNER_BAND_MISS (few land 2–2.5+)')
  if (meanPot > 0 && meanPot < 5 && a.wipe / N > 0.05) breaks.push('WIPE_POT_THIN (<5×, not 8–10)')
  if (meanPot > 12) breaks.push('WIPE_POT_OBESE (>12×)')
  if (raiderEv < -9) breaks.push('RAIDER_DUMP (EV very neg)')
  if (s.liveHard >= 12 && a.ownerShares / N < 1) breaks.push('POOL_DILUTE (many Hard, tiny shares)')
  if (s.liveHard <= 2 && a.ownerShares / N > 15) breaks.push('POOL_CONCENTRATE (fat shares on few)')

  console.log(
    breaks.length
      ? ' BREAK → ' + breaks.join('; ')
      : ' OK-ish vs Soft/Hard OR (no hard break flags)',
  )
}

function main() {
  console.log('Parity skew stress — N=', N, 'clearP=', CLEAR_P)
  console.log('Targets: owner ~2–2.5× OR raider wipe ~8–10× on held bank')
  console.log('Parity pricing = WIP; looking for when logic breaks.\n')

  // Baseline-ish (slight dungeon surplus — design lean)
  const baseline: Skew = {
    name: 'BASELINE slight dungeon surplus',
    liveHard: 4,
    liveSoft: 3,
    maxAttempts: 40,
    closeRoi: 2.0,
    meanCreateRerolls: 1.5,
    meanFriendRerolls: 1,
    createCostMul: 1,
    holdFrac: 0.35,
  }

  // Create glut: everyone wants to make dungeons
  const createGlut: Skew = {
    name: 'CREATE-GLUT (too many dungeons / few raids)',
    liveHard: 18,
    liveSoft: 4,
    maxAttempts: 8, // starved: few raids reach each dungeon
    closeRoi: 1.8,
    meanCreateRerolls: 2,
    meanFriendRerolls: 0.5,
    createCostMul: 1,
    holdFrac: 0.15, // can't afford to hold — empty
  }

  // Same glut + experimental +25% create tax
  const createGlutTax: Skew = {
    ...createGlut,
    name: 'CREATE-GLUT + create tax ×1.25',
    createCostMul: 1.25,
  }

  // Raid glut: everyone wants to raid
  const raidGlut: Skew = {
    name: 'RAID-GLUT (few dungeons / raid flood)',
    liveHard: 2,
    liveSoft: 3,
    maxAttempts: 40,
    closeRoi: 2.0,
    meanCreateRerolls: 1,
    meanFriendRerolls: 1.5,
    createCostMul: 1,
    holdFrac: 0.55, // holders chase pool on scarce Hard slots
  }

  // Extreme raid glut
  const raidGlutX: Skew = {
    ...raidGlut,
    name: 'RAID-GLUT extreme (liveHard=1)',
    liveHard: 1,
    holdFrac: 0.7,
  }

  const cases: [Skew, number][] = [
    [baseline, 0xa11],
    [createGlut, 0xb22],
    [createGlutTax, 0xb23],
    [raidGlut, 0xc33],
    [raidGlutX, 0xc34],
  ]

  for (const [s, seed] of cases) report(s, runSkew(s, seed))

  console.log('\n── verdict sketch ──')
  console.log(
    'If CREATE-GLUT breaks owner ROI → parity lever (create +25% / entry discount) worth testing.',
  )
  console.log(
    'If RAID-GLUT only concentrates pool / fat wipe pots → may be OK; excess dungeons preferred over 1:1.',
  )
  console.log('Do not ship dynamic prices until these flags are deliberate.')
}

main()
