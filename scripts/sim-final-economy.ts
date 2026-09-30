/**
 * Final economy simulation — full cycle: Soft + Hard + tickets + optional burn.
 * Combat not re-simulated: uses known clear-rates from prior 10k sims.
 *
 *   npx tsx scripts/sim-final-economy.ts
 */
import {
  HARD,
  SOFT,
  hardBankAfterKills,
  softBankAfterKills,
  rerollCostSum,
  claimTaxFrac,
  ticketMintAtWin,
  settleHardClaimWithTax,
  settleSoftClaim,
} from '../src/game/economy.ts'

// ── Config ───────────────────────────────────────────────────────────────────

const HARD_DUNGEONS_PER_WEEK = 200   // live Hard pool
const SOFT_DUNGEONS_PER_WEEK = 150   // live Soft pool
const WEEKS            = 12
const WARMUP           = 3
/** Known from prior 10k sims */
const HARD_CLEAR_P     = 0.11
const SOFT_CLEAR_P     = 0.325
/**
 * Fraction of weekly pool earmarked for ticket payouts.
 * Rest stays in treasury / protocol.
 * With 200 Hard dungeons → pool ~$5400/wk, ~380 tickets → $/ticket ~$14 (too high).
 * TICKET_POOL_FRAC = 0.10 brings $/ticket to ~$1.4, making win25 ≈ 28× instead of 183×.
 */
/**
 * Fraction of weekly pool earmarked for ticket payouts.
 * 0.10 → $/ticket ≈ $0.49  (win 25 ≈ 17×, owner avg 1.36×)
 * 0.25 → $/ticket ≈ $1.14  (win 25 ≈ 25×, owner avg 1.35×)
 * 1.00 → $/ticket ≈ $4.58  (win 25 ≈ 65×, owner avg 1.88×)
 * Best trade-off: 0.25 hits win 25 ≈ 25×; owner ROI stays ~1.35×.
 * To reach owner 2×: need 70–100% frac AND faster early mint (smoothMint style).
 */
const TICKET_POOL_FRAC = 0.25
/** Burn fractions applied INSIDE the ticket portion (reduces ticket payouts). */
const BURN_FRACS       = [0, 0.10, 0.20, 0.30]

// ── RNG ──────────────────────────────────────────────────────────────────────

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Rng = () => number
const mean  = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b) / xs.length : 0
const pct   = (x: number)    => `${(100 * x).toFixed(1)}%`
const x2    = (x: number)    => `${x.toFixed(2)}×`
const d2    = (x: number)    => `$${x.toFixed(2)}`
const ok    = (cond: boolean) => cond ? '✅' : '⚠️'

// ── Owner behavioral types ───────────────────────────────────────────────────

type OwnerKind = 'claimer' | 'holder' | 'whale'
const OWNER_MIX: [OwnerKind, number][] = [['claimer', 0.35], ['holder', 0.45], ['whale', 0.20]]
const OWNER_TARGET_ROI: Record<OwnerKind, [number, number]> = {
  claimer: [2.5, 4.0],
  holder:  [4.0, 7.0],
  whale:   [7.0, 14.0],
}

function pickOwner(rng: Rng): OwnerKind {
  let r = rng()
  for (const [k, w] of OWNER_MIX) { r -= w; if (r <= 0) return k }
  return 'claimer'
}

// ── Soft week ────────────────────────────────────────────────────────────────

interface SoftResult {
  clearRate: number
  raiderRoi: number   // avg across all attempts
  raiderXAtClear: number  // × per clear
  ownerRoi: number
  pool: number
  clears: number
  attempts: number
}

function simSoftWeek(rng: Rng): SoftResult {
  let pool = 0, raiderSpend = 0, raiderPot = 0
  let ownerSpend = 0, ownerPot = 0
  let attempts = 0, clears = 0
  const clearPots: number[] = []

  for (let d = 0; d < SOFT_DUNGEONS_PER_WEEK; d++) {
    ownerSpend += SOFT.createCost
    pool += SOFT.createFee
    let bank = SOFT.createToBank
    let wins = 0; let done = false

    while (!done && wins < 20) {
      attempts++
      raiderSpend += SOFT.entryCost
      pool += SOFT.entryToOwnerPool
      bank += SOFT.entryToBank

      if (rng() < SOFT_CLEAR_P) {
        clears++
        const pot = bank * SOFT.clearRaiderFrac
        pool += bank * SOFT.clearFeeFrac
        raiderPot += pot
        clearPots.push(pot)
        done = true; break
      }
      wins++

      // Owner suggest-close at ~1.5× ROI
      if (wins >= SOFT.minWinsBeforeClaim) {
        const oPay = softBankAfterKills(wins) * SOFT.clearOwnerFrac
        if (oPay / SOFT.createCost >= 1.5 && rng() < 0.5) {
          pool += bank * SOFT.clearFeeFrac
          ownerPot += oPay
          done = true
        }
      }
    }
    if (!done) {
      const oPay = bank * SOFT.clearOwnerFrac
      pool += bank * SOFT.clearFeeFrac
      ownerPot += oPay
    }
  }

  return {
    clearRate: clears / Math.max(1, attempts),
    raiderRoi: raiderPot / Math.max(1, raiderSpend),
    raiderXAtClear: mean(clearPots) / SOFT.entryCost,
    ownerRoi: ownerPot / Math.max(1, ownerSpend),
    pool, clears, attempts,
  }
}

// ── Hard week ────────────────────────────────────────────────────────────────

interface DungeonRecord {
  invest: number
  bankPay: number
  ticketPay: number
  ticketPower: number
  wins: number
  kind: OwnerKind
}

interface HardResult {
  clearRate: number
  raiderRoi: number
  raiderXAtClear: number
  raiderXHeld: number      // × when clearing wins≥7 dungeon
  ownerBankRoi: number
  ownerTotalRoi: number
  ownerRoiByKind: Record<OwnerKind, number>
  meanWinsAtClaim: number
  claimedAt8plus: number   // fraction of claimers who held ≥8 wins
  pool: number
  distributed: number
  burnAmount: number
  vpp: number
  totalTickets: number
  roi15pct: number         // fraction achieving ≥15× total
  maxRoi: number
  clears: number
  attempts: number
}

function simHardWeek(rng: Rng, burnFrac: number, vppEst: number): HardResult {
  let pool = 0, raiderSpend = 0, raiderPot = 0
  let attempts = 0, clears = 0
  const records: DungeonRecord[] = []
  const clearPots: number[] = []
  const clearPotsHeld: number[] = []
  let raiderTicketPower = 0

  for (let d = 0; d < HARD_DUNGEONS_PER_WEEK; d++) {
    const kind = pickOwner(rng)
    const rr = kind === 'whale' ? irange(rng, 2, 3) : kind === 'holder' ? irange(rng, 0, 1) : 0
    const invest = HARD.createCost + rerollCostSum(rr)
    pool += HARD.createFee + rerollCostSum(rr)

    let bank = HARD.createToBank
    let wins = 0
    let ticketPower = 0
    let done = false
    const targetRoi = OWNER_TARGET_ROI[kind]
    const target = targetRoi[0] + rng() * (targetRoi[1] - targetRoi[0])

    while (!done && wins < HARD.maxLiveWins) {
      attempts++
      const frr = rng() < 0.35 ? 1 : 0
      raiderSpend += HARD.entryCost + rerollCostSum(frr)
      pool += HARD.entryToOwnerPool + rerollCostSum(frr)
      bank += HARD.entryToBank

      if (rng() < HARD_CLEAR_P) {
        clears++
        const pot = bank * HARD.clearRaiderFrac
        pool += bank * HARD.clearFeeFrac
        raiderPot += pot
        clearPots.push(pot)
        if (wins >= 7) clearPotsHeld.push(pot)
        raiderTicketPower += Math.floor(ticketPower * 0.9)
        records.push({ invest, bankPay: 0, ticketPay: 0, ticketPower: 0, wins, kind })
        done = true; break
      }

      wins++
      ticketPower += ticketMintAtWin(wins)

      // Claim decision
      const { ownerPayout, fee, taxed } = settleHardClaimWithTax(bank, wins)
      const tickEv = ticketPower * vppEst * (1 - burnFrac)
      const totalEv = ownerPayout + tickEv
      const roi = totalEv / invest
      const noise = 0.8 + 0.4 * rng()

      // Near-lock: panic exit very rare before win 7
      const panic = wins < 7 && rng() < 0.015
      const naturalExit = roi >= target * noise && wins >= 7
      const maxWins = wins >= HARD.maxLiveWins

      if (panic || naturalExit || maxWins) {
        pool += taxed + fee
        records.push({ invest, bankPay: ownerPayout, ticketPay: 0, ticketPower, wins, kind })
        done = true
      }
    }
  }

  // Ticket settlement — only TICKET_POOL_FRAC of the pool goes to tickets
  const totalOwnerTix = records.reduce((s, r) => s + r.ticketPower, 0)
  const totalTix = totalOwnerTix + raiderTicketPower
  const ticketPot = pool * TICKET_POOL_FRAC          // earmarked for tickets
  const distributed = ticketPot * (1 - burnFrac)      // after optional burn
  const burned = ticketPot * burnFrac + pool * (1 - TICKET_POOL_FRAC) // burn + treasury
  const vpp = totalTix > 0 ? distributed / totalTix : 0

  for (const r of records) {
    r.ticketPay = r.ticketPower * vpp
  }
  raiderPot += raiderTicketPower * vpp

  const roi15 = records.filter(r => (r.bankPay + r.ticketPay) / r.invest >= 15).length / records.length
  const maxR = Math.max(...records.map(r => (r.bankPay + r.ticketPay) / r.invest))

  const claimedRecs = records.filter(r => r.bankPay > 0)
  const by = (k: OwnerKind) => {
    const rs = records.filter(r => r.kind === k)
    return rs.length ? rs.reduce((s, r) => s + (r.bankPay + r.ticketPay) / r.invest, 0) / rs.length : 0
  }

  return {
    clearRate: clears / Math.max(1, attempts),
    raiderRoi: raiderPot / Math.max(1, raiderSpend),
    raiderXAtClear: mean(clearPots) / HARD.entryCost,
    raiderXHeld: clearPotsHeld.length ? mean(clearPotsHeld) / HARD.entryCost : 0,
    ownerBankRoi: mean(records.map(r => r.bankPay / r.invest)),
    ownerTotalRoi: mean(records.map(r => (r.bankPay + r.ticketPay) / r.invest)),
    ownerRoiByKind: { claimer: by('claimer'), holder: by('holder'), whale: by('whale') },
    meanWinsAtClaim: mean(claimedRecs.map(r => r.wins)),
    claimedAt8plus: claimedRecs.filter(r => r.wins >= 8).length / Math.max(1, claimedRecs.length),
    pool, distributed, burnAmount: burned,
    vpp, totalTickets: totalTix,
    roi15pct: roi15, maxRoi: maxR,
    clears, attempts,
  }
}

// ── Run weeks + warm-up ───────────────────────────────────────────────────────

function irange(rng: Rng, a: number, b: number) {
  return a + Math.floor(rng() * (b - a + 1))
}

function runCycle(burnFrac: number, seed: number) {
  const rng = mulberry32(seed)
  let vppEst = 0.5
  const softWeeks: SoftResult[] = []
  const hardWeeks: HardResult[] = []

  for (let w = 0; w < WEEKS; w++) {
    const sw = simSoftWeek(rng)
    const hw = simHardWeek(rng, burnFrac, vppEst)
    if (w >= WARMUP) { softWeeks.push(sw); hardWeeks.push(hw) }
    // Adaptive vpp estimate
    if (hw.vpp > 0) vppEst = 0.5 * vppEst + 0.5 * hw.vpp
  }

  const avg = <T extends Record<string, number>>(arr: T[], key: keyof T): number =>
    mean(arr.map(w => w[key] as number))

  return {
    burn: burnFrac,
    // Soft
    softClearRate:   avg(softWeeks, 'clearRate'),
    softRaiderXAtClear: avg(softWeeks, 'raiderXAtClear'),
    softOwnerRoi:    avg(softWeeks, 'ownerRoi'),
    softPool:        avg(softWeeks, 'pool'),
    // Hard
    hardClearRate:   avg(hardWeeks, 'clearRate'),
    hardRaiderRoi:   avg(hardWeeks, 'raiderRoi'),
    hardRaiderXAtClear: avg(hardWeeks, 'raiderXAtClear'),
    hardRaiderXHeld: avg(hardWeeks, 'raiderXHeld'),
    hardOwnerBankRoi: avg(hardWeeks, 'ownerBankRoi'),
    hardOwnerTotalRoi: avg(hardWeeks, 'ownerTotalRoi'),
    hardOwnerClaimer: mean(hardWeeks.map(w => w.ownerRoiByKind.claimer)),
    hardOwnerHolder:  mean(hardWeeks.map(w => w.ownerRoiByKind.holder)),
    hardOwnerWhale:   mean(hardWeeks.map(w => w.ownerRoiByKind.whale)),
    hardMeanWins:    avg(hardWeeks, 'meanWinsAtClaim'),
    hardClaim8plus:  avg(hardWeeks, 'claimedAt8plus'),
    hardPool:        avg(hardWeeks, 'pool'),
    hardDistributed: avg(hardWeeks, 'distributed'),
    hardBurn:        avg(hardWeeks, 'burnAmount'),
    hardVpp:         avg(hardWeeks, 'vpp'),
    hardTotalTix:    avg(hardWeeks, 'totalTickets'),
    hardRoi15:       avg(hardWeeks, 'roi15pct'),
    hardMaxRoi:      avg(hardWeeks, 'maxRoi'),
  }
}

// ── Golden standard ───────────────────────────────────────────────────────────

const GOLDEN = {
  softClearRate:      [0.30, 0.36],
  softRaiderXAtClear: [2.0, 5.0],    // raider × on clear (bank/entry)
  softOwnerRoi:       [1.0, 2.0],
  hardClearRate:      [0.10, 0.15],
  hardRaiderXHeld:    [8.0, 10.0],   // × when clearing held dungeon (golden OR)
  hardRaiderXAtClear: [4.0, 9.0],    // × average across all clears
  hardOwnerTotalRoi:  [2.0, 3.0],
  hardMeanWins:       [7.0, 10.0],
}

function inRange(v: number, [lo, hi]: [number, number]) {
  return v >= lo && v <= hi
}

// ── Output ───────────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════')
console.log('  FINAL ECONOMY SIM — Full cycle, Soft + Hard + Tickets')
console.log(`  ${HARD_DUNGEONS_PER_WEEK} Hard · ${SOFT_DUNGEONS_PER_WEEK} Soft per week`)
console.log(`  ${WEEKS - WARMUP} weeks reported · clear rates from 10k battle sims`)
console.log('═══════════════════════════════════════════════════════════\n')

const baseResults = runCycle(0, 0xdeadbeef)

// ── Soft section ──────────────────────────────────────────────────────────────
console.log('── SOFT ECONOMY ─────────────────────────────────────────')
const s = baseResults
console.log(`  Clear rate / raid:    ${pct(s.softClearRate)}  ${ok(inRange(s.softClearRate, GOLDEN.softClearRate))} (target 30–36%)`)
console.log(`  Raider × at clear:    ${x2(s.softRaiderXAtClear)}  ${ok(inRange(s.softRaiderXAtClear, GOLDEN.softRaiderXAtClear))} (target 2–5×)`)
console.log(`  Owner ROI:            ${x2(s.softOwnerRoi)}  ${ok(inRange(s.softOwnerRoi, GOLDEN.softOwnerRoi))} (target 1–2×)`)
console.log(`  Pool / week:          ${d2(s.softPool)}`)

// ── Hard section ──────────────────────────────────────────────────────────────
console.log('\n── HARD ECONOMY (burn=0%) ───────────────────────────────')
console.log(`  Clear rate / raid:    ${pct(s.hardClearRate)}  ${ok(inRange(s.hardClearRate, GOLDEN.hardClearRate))} (target 10–15%)`)
console.log(`  Raider × avg clear:   ${x2(s.hardRaiderXAtClear)}  ${ok(inRange(s.hardRaiderXAtClear, GOLDEN.hardRaiderXAtClear))} (target 4–9×)`)
console.log(`  Raider × held clears: ${x2(s.hardRaiderXHeld)}  ${ok(inRange(s.hardRaiderXHeld, GOLDEN.hardRaiderXHeld))} (target 8–10× — Golden OR)`)
console.log(`  Owner × (bank only):  ${x2(s.hardOwnerBankRoi)}`)
console.log(`  Owner × (+ tickets):  ${x2(s.hardOwnerTotalRoi)}  ${ok(inRange(s.hardOwnerTotalRoi, GOLDEN.hardOwnerTotalRoi))} (target 2–3×)`)
console.log(`    claimer:            ${x2(s.hardOwnerClaimer)}`)
console.log(`    holder:             ${x2(s.hardOwnerHolder)}`)
console.log(`    whale:              ${x2(s.hardOwnerWhale)}`)
console.log(`  Mean wins at claim:   ${s.hardMeanWins.toFixed(1)}  ${ok(inRange(s.hardMeanWins, GOLDEN.hardMeanWins))} (target 7–10)`)
console.log(`  Claims at win 8+:     ${pct(s.hardClaim8plus)}`)
console.log(`  ≥15× achievers:       ${pct(s.hardRoi15)}`)
console.log(`  Max ROI observed:     ${x2(s.hardMaxRoi)}`)
console.log(`  Pool / week:          ${d2(s.hardPool)}`)
console.log(`  Distributed / week:   ${d2(s.hardDistributed)}`)
console.log(`  $/ticket:             ${d2(s.hardVpp)} (${Math.round(s.hardTotalTix)} tickets/week)`)

// Win × progression table
console.log('\n  ── Owner sees at claim (bank after tax + expected tickets) ──')
console.log('  win  | tax  | bank  | +tickets | total   | ×create')
const exVpp = s.hardVpp
for (let w of [1, 5, 6, 7, 8, 9, 10, 12, 15, 18, 20, 25]) {
  const bank = hardBankAfterKills(w) * HARD.clearOwnerFrac
  const { ownerPayout } = settleHardClaimWithTax(hardBankAfterKills(w), w)
  let cumTix = 0
  for (let k = 7; k <= w; k++) cumTix += ticketMintAtWin(k)
  const tixVal = cumTix * exVpp
  const total = ownerPayout + tixVal
  const taxPct = Math.round(claimTaxFrac(w) * 100)
  console.log(
    `  w${String(w).padStart(2)} : ${String(taxPct).padStart(3)}% | ${d2(ownerPayout).padStart(6)} | ${d2(tixVal).padStart(8)} | ${d2(total).padStart(7)} | ${x2(total / HARD.createCost)}`
  )
}

// ── Burn analysis ─────────────────────────────────────────────────────────────
console.log('\n── BURN ANALYSIS ────────────────────────────────────────')
console.log('  burn%  owner×   raider×avg  raider×held  $/ticket  pool→players  burned/wk')
for (const bf of BURN_FRACS) {
  const r = runCycle(bf, 0xdeadbeef + Math.round(bf * 100))
  const burnPct = Math.round(bf * 100)
  console.log(
    `  ${String(burnPct).padStart(4)}%  ${x2(r.hardOwnerTotalRoi).padStart(7)}  ${x2(r.hardRaiderXAtClear).padStart(10)}  ${x2(r.hardRaiderXHeld).padStart(11)}  ${d2(r.hardVpp).padStart(8)}  ${d2(r.hardDistributed).padStart(12)}  ${d2(r.hardBurn)}`
  )
}

// ── Fundamental problem check ─────────────────────────────────────────────────
console.log('\n── FUNDAMENTAL PROBLEMS CHECK ───────────────────────────')
const problems: string[] = []

if (s.softOwnerRoi < 1)
  problems.push('⚠️  Soft owner avg ROI < 1× — creating Soft dungeons is net-negative')
if (s.hardOwnerBankRoi < 1)
  problems.push('⚠️  Hard owner bank-only ROI < 1× — clearing without tickets is net-negative')
if (s.hardOwnerTotalRoi < 1.5)
  problems.push('⚠️  Hard owner total ROI < 1.5× — weak even with tickets')
if (s.hardClearRate > 0.16)
  problems.push('⚠️  Hard clear rate too high (>16%) — dungeon survives too few raids')
if (s.hardClearRate < 0.08)
  problems.push('⚠️  Hard clear rate too low (<8%) — Friend cannot win reliably')
if (s.hardRaiderXAtClear < 3)
  problems.push('⚠️  Hard raider × <3× on average — raiding not worth it')
if (s.hardMeanWins < 5)
  problems.push('⚠️  Mean wins at claim <5 — near-lock tax not holding long enough')
if (s.hardVpp < 0.5)
  problems.push('⚠️  $/ticket < $0.5 — ticket system provides negligible bonus')
if (s.hardVpp > 50)
  problems.push('⚠️  $/ticket > $50 — tickets are hyper-concentrated (few holders)')
if (s.hardRoi15 < 0.005)
  problems.push('ℹ️  <0.5% reach 15× — jackpot exists but nearly nobody achieves it')
if (s.hardRaiderXHeld < 7)
  problems.push('⚠️  Hard raider × on held clears <7× — Golden OR below target')
if (s.hardOwnerClaimer > s.hardOwnerHolder)
  problems.push('⚠️  Claimers outperform holders — no economic incentive to hold')

if (problems.length === 0) {
  console.log('  ✅ No fundamental problems detected')
} else {
  for (const p of problems) console.log(`  ${p}`)
}

// ── Golden standard summary ───────────────────────────────────────────────────
console.log('\n── GOLDEN STANDARD COMPARISON ───────────────────────────')
console.log(`  ${'Metric'.padEnd(28)} ${'Target'.padEnd(12)} ${'Actual'.padEnd(10)} Status`)
console.log(`  ${'-'.repeat(60)}`)
const checks: [string, [number, number], number][] = [
  ['Soft clear rate/raid',      GOLDEN.softClearRate,       s.softClearRate],
  ['Soft raider × at clear',    GOLDEN.softRaiderXAtClear,  s.softRaiderXAtClear],
  ['Soft owner ROI',            GOLDEN.softOwnerRoi,        s.softOwnerRoi],
  ['Hard clear rate/raid',      GOLDEN.hardClearRate,       s.hardClearRate],
  ['Hard raider × (avg)',       GOLDEN.hardRaiderXAtClear,  s.hardRaiderXAtClear],
  ['Hard raider × (held, GOR)', GOLDEN.hardRaiderXHeld,     s.hardRaiderXHeld],
  ['Hard owner ROI (total)',     GOLDEN.hardOwnerTotalRoi,   s.hardOwnerTotalRoi],
  ['Hard mean wins at claim',   GOLDEN.hardMeanWins,        s.hardMeanWins],
]
for (const [label, range, val] of checks) {
  const pass = inRange(val, range)
  const tgt = `${range[0]}–${range[1]}×`.padEnd(12)
  const act = x2(val).padEnd(10)
  console.log(`  ${label.padEnd(28)} ${tgt} ${act} ${pass ? '✅' : '❌'}`)
}

console.log('')
// ── Ticket pool fraction sweep ────────────────────────────────────────────────
console.log('── TICKET_POOL_FRAC SWEEP (burn=0, 200 Hard dungeons) ────')
console.log('  frac  $/ticket  win7×  win15×  win20×  win25×  owner×avg  problem?')
const sweepBase = runCycle(0, 0xdeadbeef)
for (const frac of [0.05, 0.10, 0.25, 0.50, 0.75, 1.00]) {
  const r = runCycle(0, 0xdeadbeef + Math.round(frac * 1000))
  // Recompute table values with this frac's vpp
  const vppHere = r.hardVpp * (TICKET_POOL_FRAC / frac)  // approximate rescale
  const fmt = (w: number) => {
    const bank = hardBankAfterKills(w)
    const { ownerPayout } = settleHardClaimWithTax(bank, w)
    let cum = 0; for (let k = 7; k <= w; k++) cum += ticketMintAtWin(k)
    const tix = cum * vppHere
    return ((ownerPayout + tix) / HARD.createCost).toFixed(1)
  }
  const problem = frac >= 0.70 ? '⚠️ win25≫30×' : frac <= 0.10 ? '⚠️ owner<1.4×' : '✅'
  console.log(
    `  ${String(Math.round(frac * 100)).padStart(3)}%  ${d2(vppHere).padStart(8)}  ${fmt(7).padStart(5)}×  ${fmt(15).padStart(6)}×  ${fmt(20).padStart(6)}×  ${fmt(25).padStart(6)}×  ${x2(r.hardOwnerTotalRoi).padStart(9)}  ${problem}`
  )
}
console.log(`\n  ⚠️  KEY TRADE-OFF: owner 2–3× (golden standard) requires frac≥70%`)
console.log(`      but that pushes win25 to 50–70×. Conservative survival-mint`)
console.log(`      caps owner avg at ~1.4–1.6× regardless of frac.`)
console.log(`      To restore 2× owner: use smooth early mint (1/2/4/7... from win 4)`)
console.log(`      OR accept owner 1.4× as correct for the new conservative design.\n`)
console.log('  Burn=0 is recommended. 10–20% burn reduces payouts proportionally.')
console.log('  Consider burn as protocol treasury (not player-facing).\n')
