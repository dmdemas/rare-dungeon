/**
 * Parity + human behavior: 1000 Hard lives × scenarios.
 * Raid-glut → cheaper entry so wipe mult vs stake rises (less $ in, same fat bank).
 *
 * npx tsx scripts/sim-parity-behavior.ts
 */
import {
  HARD,
  distributePoolEpoch,
  entryMulFromPressure,
  hardClosePayout,
  hardRaiderClearPayout,
  hardRoi,
  quoteHardEntry,
  rerollCostSum,
} from '../src/game/economy.ts'

const N = 1000
const CLEAR_P = HARD.targetClearP

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function entryQuote(entryMul: number) {
  const q = quoteHardEntry(entryMul)
  return { cost: q.cost, toBank: q.toBank, toPool: q.toPool }
}

type OwnerKind = 'claimer' | 'holder' | 'whale'
type RaiderKind = 'bare' | 'perk1' | 'perkHunt' | 'yolo'

type Mix = {
  name: string
  liveHard: number
  liveSoft: number
  /** Desired raids per live Hard (demand). Drives entryMul + attempt flood. */
  raidDemandPerHard: number
  maxAttempts: number
  createCostMul: number
  owners: { kind: OwnerKind; w: number }[]
  raiders: { kind: RaiderKind; w: number }[]
  /** If true, apply entryMulFromPressure; else always 1. */
  dynamicEntry: boolean
}

type Agg = {
  ownerRoi: number
  ownerShares: number
  ownerClaim: number
  invest: number
  wipe: number
  mid: number
  hi: number
  low: number
  kills: number
  att: number
  rSpend: number
  rWon: number
  potsVsBase: number[] // pot / HARD.entryCost ($10)
  potsVsPaid: number[] // pot / actual entry paid that raid
  m810base: number
  m810paid: number
  m12plusPaid: number
  entryMulSum: number
  poolIn: number
}

function pick<T extends { w: number }>(rng: () => number, items: T[]): T {
  const t = items.reduce((s, x) => s + x.w, 0)
  let u = rng() * t
  for (const x of items) {
    u -= x.w
    if (u <= 0) return x
  }
  return items[items.length - 1]!
}

function ownerCloseRoi(kind: OwnerKind): number {
  if (kind === 'holder') return 99
  if (kind === 'whale') return 2.5
  return 2.0
}

function createRerolls(kind: OwnerKind, rng: () => number): number {
  if (kind === 'whale') return 2 + Math.floor(rng() * 3) // 2–4
  if (kind === 'holder') return 1 + Math.floor(rng() * 2) // 1–2
  return Math.floor(rng() * 2) // 0–1
}

function friendRerolls(kind: RaiderKind, rng: () => number): number {
  if (kind === 'bare') return 0
  if (kind === 'perk1') return 1
  if (kind === 'perkHunt') return 1 + Math.floor(rng() * 3) // 1–3
  return Math.floor(rng() * 4) // yolo 0–3
}

function run(mix: Mix, seed: number): Agg {
  const rng = mulberry32(seed)
  const pressure = mix.raidDemandPerHard
  const entryMul = mix.dynamicEntry ? entryMulFromPressure(pressure) : 1
  const q = entryQuote(entryMul)
  const createCost = HARD.createCost * mix.createCostMul

  const a: Agg = {
    ownerRoi: 0,
    ownerShares: 0,
    ownerClaim: 0,
    invest: 0,
    wipe: 0,
    mid: 0,
    hi: 0,
    low: 0,
    kills: 0,
    att: 0,
    rSpend: 0,
    rWon: 0,
    potsVsBase: [],
    potsVsPaid: [],
    m810base: 0,
    m810paid: 0,
    m12plusPaid: 0,
    entryMulSum: 0,
    poolIn: 0,
  }

  for (let d = 0; d < N; d++) {
    const ok = pick(rng, mix.owners).kind
    const closeRoi = ownerCloseRoi(ok)
    const cr = createRerolls(ok, rng)
    const cr$ = rerollCostSum(cr)
    const invested = createCost + cr$
    let shares = 0
    a.poolIn += cr$
    shares += distributePoolEpoch(cr$, mix.liveSoft, mix.liveHard).hardPerDungeon

    let bank = HARD.createToBank
    let kills = 0
    let claim = 0
    let wiped = false
    let attempts = 0

    while (attempts < mix.maxAttempts && kills < HARD.maxLiveWins) {
      const rk = pick(rng, mix.raiders).kind
      const fr = friendRerolls(rk, rng)
      const fr$ = rerollCostSum(fr)
      attempts++
      a.att++
      a.entryMulSum += entryMul
      a.rSpend += q.cost + fr$
      const poolAdd = q.toPool + fr$
      a.poolIn += poolAdd
      bank += q.toBank

      if (rng() < CLEAR_P) {
        const pot = hardRaiderClearPayout(bank)
        a.rWon += pot
        const mb = pot / HARD.entryCost
        const mp = pot / q.cost
        a.potsVsBase.push(mb)
        a.potsVsPaid.push(mp)
        if (mb >= 8 && mb <= 10.5) a.m810base++
        if (mp >= 8 && mp <= 10.5) a.m810paid++
        if (mp >= 12) a.m12plusPaid++
        wiped = true
        shares += distributePoolEpoch(poolAdd, mix.liveSoft, mix.liveHard).hardPerDungeon
        break
      }

      kills++
      shares += distributePoolEpoch(poolAdd, mix.liveSoft, mix.liveHard).hardPerDungeon
      const pay = hardClosePayout(bank, kills)
      if (kills >= HARD.minWinsBeforeClaim && hardRoi(pay, createCost) >= closeRoi - 0.02) {
        claim = pay
        break
      }
    }

    if (!wiped && !claim) claim = hardClosePayout(bank, kills)

    const roi = hardRoi(claim + shares, invested)
    a.ownerRoi += roi
    a.ownerShares += shares
    a.ownerClaim += claim
    a.invest += invested
    a.kills += kills
    if (wiped) a.wipe++
    else if (roi >= 2 && roi < 2.5) a.mid++
    else if (roi >= 2.5) a.hi++
    else a.low++
  }
  return a
}

function mean(xs: number[]) {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0
}
function pct(x: number) {
  return (100 * x).toFixed(1) + '%'
}

function report(mix: Mix, a: Agg) {
  const pressure = mix.raidDemandPerHard
  const em = mix.dynamicEntry ? entryMulFromPressure(pressure) : 1
  const q = entryQuote(em)
  const potB = mean(a.potsVsBase)
  const potP = mean(a.potsVsPaid)
  const ev = (a.rWon - a.rSpend) / Math.max(1, a.att)
  const clears = a.potsVsPaid.length

  console.log('\n══ ' + mix.name + ' ══')
  console.log(
    ` pressure=${pressure.toFixed(1)} entryMul=${em} → entry $${q.cost.toFixed(2)} (bank+$${q.toBank.toFixed(2)} pool+$${q.toPool.toFixed(2)})`,
  )
  console.log(
    ` owner ROI ${ (a.ownerRoi / N).toFixed(2)}× | claim$${(a.ownerClaim / N).toFixed(1)} shares$${(a.ownerShares / N).toFixed(1)} | wipe ${pct(a.wipe / N)} 2–2.5 ${pct(a.mid / N)} 2.5+ ${pct(a.hi / N)} low ${pct(a.low / N)}`,
  )
  console.log(
    ` raider EV/att $${ev.toFixed(3)} | clear pot vs $10: ${potB.toFixed(2)}× | vs paid entry: ${potP.toFixed(2)}×`,
  )
  console.log(
    ` of clears: 8–10.5 vs$10 ${pct(clears ? a.m810base / clears : 0)} | 8–10.5 vsPaid ${pct(clears ? a.m810paid / clears : 0)} | ≥12× vsPaid ${pct(clears ? a.m12plusPaid / clears : 0)}`,
  )
  console.log(
    ` mean kills ${(a.kills / N).toFixed(1)} | pool$/life ${(a.poolIn / N).toFixed(1)}`,
  )

  const breaks: string[] = []
  if (em < 1 && potP < potB * 1.05) breaks.push('DISCOUNT_NO_MULT_LIFT')
  if (em < 1 && potP >= 12) breaks.push('PAID_MULT_SPIKE (≥12× — check fairness)')
  if (pressure >= 2 && em === 1) breaks.push('RAID_GLUT_NO_DISCOUNT')
  if (a.wipe / N > 0.85 && (a.ownerRoi / N) < 1.3) breaks.push('OWNERS_WIPED_THIN')
  if (potP > 0 && potP < 5 && pressure < 1.5) breaks.push('THIN_POT_NORMAL_PRICE')
  console.log(breaks.length ? ' FLAG → ' + breaks.join('; ') : ' flags: none')
}

function main() {
  console.log('Behavior + raid-entry discount — N=', N, 'clearP=', CLEAR_P)
  console.log(
    'Rule: raidDemand/liveHard high → cheaper entry; wipe mult measured vs PAID stake.\n',
  )

  const balancedPeople: Mix = {
    name: 'BALANCED humans (claimer/holder/whale · bare/perk)',
    liveHard: 4,
    liveSoft: 3,
    raidDemandPerHard: 1,
    maxAttempts: 40,
    createCostMul: 1,
    dynamicEntry: true,
    owners: [
      { kind: 'claimer', w: 50 },
      { kind: 'holder', w: 35 },
      { kind: 'whale', w: 15 },
    ],
    raiders: [
      { kind: 'bare', w: 40 },
      { kind: 'perk1', w: 35 },
      { kind: 'perkHunt', w: 20 },
      { kind: 'yolo', w: 5 },
    ],
  }

  const createGlut: Mix = {
    name: 'CREATE-GLUT humans (many dungeons, weak demand)',
    liveHard: 16,
    liveSoft: 4,
    raidDemandPerHard: 0.4,
    maxAttempts: 8,
    createCostMul: 1,
    dynamicEntry: true,
    owners: [
      { kind: 'claimer', w: 70 },
      { kind: 'holder', w: 20 },
      { kind: 'whale', w: 10 },
    ],
    raiders: [
      { kind: 'bare', w: 55 },
      { kind: 'perk1', w: 30 },
      { kind: 'perkHunt', w: 10 },
      { kind: 'yolo', w: 5 },
    ],
  }

  const raidGlutNoDisc: Mix = {
    name: 'RAID-GLUT no discount (control)',
    liveHard: 2,
    liveSoft: 3,
    raidDemandPerHard: 3,
    maxAttempts: 40,
    createCostMul: 1,
    dynamicEntry: false,
    owners: [
      { kind: 'claimer', w: 30 },
      { kind: 'holder', w: 50 },
      { kind: 'whale', w: 20 },
    ],
    raiders: [
      { kind: 'bare', w: 25 },
      { kind: 'perk1', w: 30 },
      { kind: 'perkHunt', w: 35 },
      { kind: 'yolo', w: 10 },
    ],
  }

  const raidGlutDisc: Mix = {
    ...raidGlutNoDisc,
    name: 'RAID-GLUT + entry discount (pressure→0.6)',
    dynamicEntry: true,
  }

  const raidGlutExtreme: Mix = {
    name: 'RAID-GLUT extreme + discount (liveHard=1, pressure4→0.5)',
    liveHard: 1,
    liveSoft: 3,
    raidDemandPerHard: 4,
    maxAttempts: 40,
    createCostMul: 1,
    dynamicEntry: true,
    owners: [
      { kind: 'claimer', w: 20 },
      { kind: 'holder', w: 55 },
      { kind: 'whale', w: 25 },
    ],
    raiders: [
      { kind: 'bare', w: 20 },
      { kind: 'perk1', w: 25 },
      { kind: 'perkHunt', w: 40 },
      { kind: 'yolo', w: 15 },
    ],
  }

  const raidGlutMild: Mix = {
    name: 'RAID-GLUT mild + discount (pressure2→0.75)',
    liveHard: 3,
    liveSoft: 3,
    raidDemandPerHard: 2,
    maxAttempts: 40,
    createCostMul: 1,
    dynamicEntry: true,
    owners: [
      { kind: 'claimer', w: 40 },
      { kind: 'holder', w: 45 },
      { kind: 'whale', w: 15 },
    ],
    raiders: [
      { kind: 'bare', w: 35 },
      { kind: 'perk1', w: 35 },
      { kind: 'perkHunt', w: 25 },
      { kind: 'yolo', w: 5 },
    ],
  }

  // Bandwagon: after cheap raids, more perk hunters pile in
  const bandwagon: Mix = {
    name: 'BANDWAGON raid meta (discount + perk hunters)',
    liveHard: 2,
    liveSoft: 3,
    raidDemandPerHard: 3,
    maxAttempts: 40,
    createCostMul: 1,
    dynamicEntry: true,
    owners: [
      { kind: 'claimer', w: 25 },
      { kind: 'holder', w: 55 },
      { kind: 'whale', w: 20 },
    ],
    raiders: [
      { kind: 'bare', w: 10 },
      { kind: 'perk1', w: 25 },
      { kind: 'perkHunt', w: 50 },
      { kind: 'yolo', w: 15 },
    ],
  }

  const cases: [Mix, number][] = [
    [balancedPeople, 0x101],
    [createGlut, 0x202],
    [raidGlutMild, 0x303],
    [raidGlutNoDisc, 0x404],
    [raidGlutDisc, 0x405],
    [raidGlutExtreme, 0x506],
    [bandwagon, 0x607],
  ]

  for (const [m, seed] of cases) report(m, run(m, seed))

  console.log('\n── takeaway ──')
  console.log(
    'Compare RAID-GLUT control vs +discount: paid-entry mult should rise when entryMul drops.',
  )
  console.log(
    'Bank still scales with discounted toBank×many raids — absolute pot may thin slightly; x vs stake should lift.',
  )
}

main()
