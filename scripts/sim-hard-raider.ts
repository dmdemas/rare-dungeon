/** 10k Hard raider/owner EV. npx tsx scripts/sim-hard-raider.ts */
import {
  HARD,
  distributePoolEpoch,
  hardClosePayout,
  hardRaiderClearPayout,
  hardRoi,
  rerollCost,
  rerollCostSum,
} from '../src/game/economy.ts'
import { rollOffer } from '../src/game/perks/offer.ts'
import type { FriendPerkId } from '../src/game/perks/types.ts'

function rng32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const N = 10_000
const CLEAR_P = 0.11
const TUNE = { createToBank: 12, entryToBank: 9, entryToOwnerPool: 1, entryCost: 10, createCost: 20 }

function bankAfter(k: number) {
  return TUNE.createToBank + k * TUNE.entryToBank
}
function pct(x: number) {
  return (100 * x).toFixed(1) + '%'
}

function main() {
  console.log('N=', N, 'clearP=', CLEAR_P)
  console.log(
    'CURRENT pot@k8=',
    ((0.95 * (HARD.createToBank + 8 * HARD.entryToBank)) / HARD.entryCost).toFixed(2) + 'x',
  )
  console.log(
    'TUNE pot@k8=',
    ((0.95 * (TUNE.createToBank + 8 * TUNE.entryToBank)) / TUNE.entryCost).toFixed(2) + 'x',
  )

  console.log('\nPot table (TUNE):')
  for (let k = 0; k <= 12; k++) {
    const bank = bankAfter(k) + TUNE.entryToBank
    const pot = hardRaiderClearPayout(bank)
    const m = pot / TUNE.entryCost
    console.log(
      ' k=' + k,
      'bank$' + bank.toFixed(0),
      'pot$' + pot.toFixed(1),
      m.toFixed(2) + 'x',
      m >= 8 && m <= 10.5 ? '<--8-10' : '',
    )
  }

  // rerolls to dash
  const rng = rng32(0x51f7)
  let hits = 0,
    sumN = 0,
    sum$ = 0
  const hist = Array(8).fill(0)
  for (let i = 0; i < N; i++) {
    let n = 0,
      spent = 0,
      hit = false
    const ranks: Partial<Record<FriendPerkId, 1 | 2 | 3>> = {}
    for (;;) {
      const o = rollOffer('friend', ranks, rng)
      if (!o) break
      if (o[0] === 'dash' || o[1] === 'dash') {
        hit = true
        break
      }
      if (n >= 6) break
      spent += rerollCost(n)
      n++
    }
    if (hit) {
      hits++
      sumN += n
      sum$ += spent
      hist[n]++
    } else hist[7]++
  }
  console.log('\nRerolls to see dash on offer:')
  console.log(
    'hit',
    pct(hits / N),
    'meanRerolls',
    (sumN / hits).toFixed(2),
    'mean$',
    (sum$ / hits).toFixed(2),
  )
  for (let i = 0; i <= 6; i++) console.log(' ', i, 'rerolls', pct(hist[i] / N))
  console.log(' never', pct(hist[7] / N), '| analytic E[rerolls]=(1-p)/p=', ((1 - 2 / 6) / (2 / 6)).toFixed(2))

  function eco(label: string, fr: number, closeRoi: number) {
    const r = rng32(0xabc0 + fr * 17 + closeRoi * 100)
    let spend = 0,
      won = 0,
      clears = 0,
      att = 0
    const mults: number[] = []
    let m810 = 0
    let oRoi = 0
    const ob = { wipe: 0, low: 0, mid: 0, hi: 0 }
    for (let d = 0; d < N; d++) {
      const cr = 1 + (r() < 0.5 ? 1 : 0)
      const cr$ = rerollCostSum(cr)
      let shares = distributePoolEpoch(cr$, 3, 2).hardPerDungeon
      let kills = 0,
        claim = 0,
        wiped = false
      while (kills < 40) {
        const fr$ = rerollCostSum(fr)
        att++
        spend += TUNE.entryCost + fr$
        const poolAdd = TUNE.entryToOwnerPool + fr$
        if (r() < CLEAR_P) {
          const bank = bankAfter(kills) + TUNE.entryToBank
          const pot = hardRaiderClearPayout(bank)
          won += pot
          clears++
          const m = pot / TUNE.entryCost
          mults.push(m)
          if (m >= 8 && m <= 10.5) m810++
          wiped = true
          shares += distributePoolEpoch(poolAdd, 3, 2).hardPerDungeon
          break
        }
        kills++
        shares += distributePoolEpoch(poolAdd, 3, 2).hardPerDungeon
        const pay = hardClosePayout(bankAfter(kills), kills)
        if (kills >= 7 && hardRoi(pay) >= closeRoi - 0.02) {
          claim = pay
          break
        }
      }
      if (!wiped && !claim) claim = hardClosePayout(bankAfter(kills), kills)
      const roi = (claim + shares) / (TUNE.createCost + cr$)
      oRoi += roi
      if (wiped) ob.wipe++
      else if (roi >= 2 && roi < 2.5) ob.mid++
      else if (roi >= 2.5) ob.hi++
      else ob.low++
    }
    const meanM = mults.length ? mults.reduce((a, b) => a + b, 0) / mults.length : 0
    const fr$ = rerollCostSum(fr)
    console.log('\n' + label)
    console.log(
      ' raider EV net/att $' + ((won - spend) / att).toFixed(3),
      'clear',
      pct(clears / att),
      'spend/att $' + (spend / att).toFixed(2),
    )
    console.log(
      ' clear pot mean',
      meanM.toFixed(2) + 'x',
      'in 8-10.5:',
      pct(m810 / Math.max(1, mults.length)),
    )
    console.log(
      ' winner net ROI if',
      fr,
      'rerolls: stake $' + (TUNE.entryCost + fr$).toFixed(2),
      '→',
      (((meanM * TUNE.entryCost - fr$) / (TUNE.entryCost + fr$))).toFixed(2) + 'x',
    )
    console.log(
      ' owner meanROI',
      (oRoi / N).toFixed(2) + 'x',
      'wipe',
      pct(ob.wipe / N),
      '2-2.5',
      pct(ob.mid / N),
      '2.5+',
      pct(ob.hi / N),
      'low',
      pct(ob.low / N),
    )
  }

  for (const fr of [0, 1, 2, 3]) eco('frRerolls=' + fr + ' ownerClose@1.8', fr, 1.8)
  eco('frRerolls=1 ownerGREEDY@2.5', 1, 2.5)

  // Mixed owners: 40% close@1.8, 60% hold until clear/cap (pool chase)
  {
    const r = rng32(0x11111101)
    let spend = 0,
      won = 0,
      clears = 0,
      att = 0
    const mults: number[] = []
    let m810 = 0
    let oRoi = 0
    const ob = { wipe: 0, mid: 0, hi: 0, low: 0 }
    for (let d = 0; d < N; d++) {
      const early = r() < 0.4
      const closeRoi = early ? 1.8 : 99
      const cr = 1 + (r() < 0.5 ? 1 : 0)
      const cr$ = rerollCostSum(cr)
      let shares = distributePoolEpoch(cr$, 3, 2).hardPerDungeon
      let kills = 0,
        claim = 0,
        wiped = false
      const fr = 1
      while (kills < 40) {
        const fr$ = rerollCostSum(fr)
        att++
        spend += TUNE.entryCost + fr$
        const poolAdd = TUNE.entryToOwnerPool + fr$
        if (r() < CLEAR_P) {
          const bank = bankAfter(kills) + TUNE.entryToBank
          const pot = hardRaiderClearPayout(bank)
          won += pot
          clears++
          const m = pot / TUNE.entryCost
          mults.push(m)
          if (m >= 8 && m <= 10.5) m810++
          wiped = true
          shares += distributePoolEpoch(poolAdd, 3, 2).hardPerDungeon
          break
        }
        kills++
        shares += distributePoolEpoch(poolAdd, 3, 2).hardPerDungeon
        const pay = hardClosePayout(bankAfter(kills), kills)
        if (kills >= 7 && hardRoi(pay) >= closeRoi - 0.02) {
          claim = pay
          break
        }
      }
      if (!wiped && !claim) claim = hardClosePayout(bankAfter(kills), kills)
      const roi = (claim + shares) / (TUNE.createCost + cr$)
      oRoi += roi
      if (wiped) ob.wipe++
      else if (roi >= 2 && roi < 2.5) ob.mid++
      else if (roi >= 2.5) ob.hi++
      else ob.low++
    }
    const meanM = mults.length ? mults.reduce((a, b) => a + b, 0) / mults.length : 0
    console.log('\nMIXED owners 40% close@1.8 / 60% hold-for-pool · frRerolls=1')
    console.log(
      ' raider EV net/att $' + ((won - spend) / att).toFixed(3),
      'clear',
      pct(clears / att),
      'clear pot mean',
      meanM.toFixed(2) + 'x',
      'in 8-10.5',
      pct(m810 / Math.max(1, mults.length)),
    )
    console.log(
      ' owner meanROI',
      (oRoi / N).toFixed(2) + 'x',
      'wipe',
      pct(ob.wipe / N),
      '2-2.5',
      pct(ob.mid / N),
      '2.5+',
      pct(ob.hi / N),
    )
  }

  console.log('\nRecommend HARD.entryToBank=9 entryToOwnerPool=1 for 8-10x clears @k~7-9')
}

main()
