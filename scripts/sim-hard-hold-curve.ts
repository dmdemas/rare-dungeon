/**
 * Hard hold-curve economy sim: claim tax from dungeon bank + ticket mint per win.
 * Behavioral owners (claimer / holder / whale) and raiders (bare / perk1 / perkHunt / yolo).
 * Combat is not simulated — per-raid clear chance by raider kind (mean ~11%).
 *
 *   npx tsx scripts/sim-hard-hold-curve.ts
 */
import { HARD, hardBankAfterKills, rerollCostSum } from '../src/game/economy.ts'

const DUNGEONS_PER_WEEK = 1000
const RAIDER_ACCOUNTS = 1000
const WEEKS = 8
const WARMUP_WEEKS = 2
const SHOWN_CLEAR_P = 0.11

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Rng = () => number
const range = (rng: Rng, [a, b]: [number, number]) => a + (b - a) * rng()
const irange = (rng: Rng, [a, b]: [number, number]) => a + Math.floor(rng() * (b - a + 1))
function pick<T extends { w: number }>(rng: Rng, items: readonly T[]): T {
  const t = items.reduce((s, x) => s + x.w, 0)
  let u = rng() * t
  for (const x of items) {
    u -= x.w
    if (u <= 0) return x
  }
  return items[items.length - 1]!
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const pct = (x: number) => `${(100 * x).toFixed(1)}%`
const x2 = (x: number) => `${x.toFixed(2)}×`

// ── Curves ──────────────────────────────────────────────────────────────

type Variant = {
  name: string
  /** Claim locked below this many wins (app today: 7). */
  lockWins: number
  tax: (wins: number) => number
  mint: (wins: number) => number
  /** Claim tax also burns the same share of the dungeon's ticket power. */
  taxTickets?: boolean
  /**
   * Fraction of the weekly pool distributed as ticket payouts (0..1).
   * Default = 1.0 (all pool to tickets). Lower value = lower $/ticket,
   * so ticket bonuses are smaller and 15× appears at higher win counts.
   */
  ticketPoolFrac?: number
}

const USER_TAX = [0.5, 0.5, 0.4, 0.3, 0.2, 0.1, 0.05, 0.04] // index = wins (0 → same as 1)
function userTax(w: number): number {
  if (w <= 7) return USER_TAX[Math.max(0, w)]!
  return 0.04 * Math.pow(0.7, w - 7)
}
const USER_MINT: Record<number, number> = { 4: 1, 5: 2, 6: 4, 7: 10, 8: 12, 9: 20, 10: 50 }
function userMintUncapped(w: number): number {
  if (w < 4) return 0
  if (w <= 10) return USER_MINT[w]!
  return 50 * Math.pow(1.5, w - 10)
}
function userMintFlat50(w: number): number {
  return w <= 10 ? userMintUncapped(w) : 50
}
/** Smoothed: 1,2,4,7,12,20,32,50 then +20% per win, capped at 120. */
const SMOOTH_MINT: Record<number, number> = { 4: 1, 5: 2, 6: 4, 7: 7, 8: 12, 9: 20, 10: 32, 11: 50 }
function smoothMint(w: number): number {
  if (w < 4) return 0
  if (w <= 11) return SMOOTH_MINT[w]!
  return Math.min(120, 50 * Math.pow(1.2, w - 11))
}

/**
 * Slow-linear: 0 until win 7, then flat steps that grow every 5 wins.
 */
function slowLinMint(w: number): number {
  if (w < 7) return 0
  return Math.min(5, 1 + Math.floor((w - 7) / 5))
}

/**
 * Survival-proportional mint: mint per win ∝ 1/P(survive to w).
 * P(w) = 0.89^w → mint(w) = round(1.12^max(0, w-7)).
 * At win 7: 1 ticket. At win 15: 2. At win 20: 4. At win 25: 8. At win 30: 14.
 * Combined with a tiny ticketPoolFrac keeps early-win value near 0 so win 7–8 ≈ bank only.
 */
function survivalMint(w: number): number {
  if (w < 7) return 0
  return Math.max(1, Math.round(Math.pow(1.12, w - 7)))
}

/**
 * Round-number "soft lock" tax.
 * Near-unacceptable (95–50%) below raider×=8 (≈ win 7), fast drop after.
 * wins 1→5: 95/90/80/70/50 % · wins 6: 20% · win 7: 5% · win 8: 0%.
 * Technically withdrawable at any win; economically insane before win 6.
 */
const NEAR_LOCK_TAX = [0, 0.95, 0.90, 0.80, 0.70, 0.50, 0.20, 0.05, 0]
function nearLockTax(w: number): number {
  if (w <= 0) return 0.95
  if (w >= NEAR_LOCK_TAX.length) return 0
  return NEAR_LOCK_TAX[w]!
}

/**
 * Softer round-number tax — "not as serious".
 * wins 1→5: 80/70/60/50/30 % · win 6: 15% · win 7: 5% · win 8: 0%.
 */
const SOFT_ROUND_TAX = [0, 0.80, 0.70, 0.60, 0.50, 0.30, 0.15, 0.05, 0]
function softRoundTax(w: number): number {
  if (w <= 0) return 0.80
  if (w >= SOFT_ROUND_TAX.length) return 0
  return SOFT_ROUND_TAX[w]!
}

/** Steep: 90/80/70/55/40/25/10 on wins 1–7, then 5 / 2 / 0. */
const STEEP_TAX = [0.9, 0.9, 0.8, 0.7, 0.55, 0.4, 0.25, 0.1, 0.05, 0.02]
function steepTax(w: number): number {
  return w < STEEP_TAX.length ? STEEP_TAX[Math.max(0, w)]! : 0
}

const VARIANTS: Variant[] = [
  { name: 'V0 сейчас: lock 7, без налога, без билетов', lockWins: 7, tax: () => 0, mint: () => 0 },
  { name: 'V1 только налог (50→4%→0)', lockWins: 0, tax: userTax, mint: () => 0 },
  { name: 'V2 налог + билеты как в ТЗ (11+ ×1.5, без потолка)', lockWins: 0, tax: userTax, mint: userMintUncapped },
  { name: 'V3 налог + билеты ТЗ, с 11+ плоско 50', lockWins: 0, tax: userTax, mint: userMintFlat50 },
  { name: 'V4 налог + сглаженные билеты (потолок 120)', lockWins: 0, tax: userTax, mint: smoothMint },
  { name: 'V5 КРУТОЙ налог 90→10% + сглаженные билеты', lockWins: 0, tax: steepTax, mint: smoothMint },
  { name: 'V6 lock 7 (как сейчас) + сглаженные билеты', lockWins: 7, tax: () => 0, mint: smoothMint },
]

// ── People ──────────────────────────────────────────────────────────────

type OwnerKind = 'claimer' | 'holder' | 'whale'
const OWNERS = [
  { kind: 'claimer' as OwnerKind, w: 0.35, lam: [2, 4] as [number, number], target: [1.3, 2.0] as [number, number], rerolls: [0, 1] as [number, number] },
  { kind: 'holder' as OwnerKind, w: 0.45, lam: [1, 2] as [number, number], target: [2.5, 4] as [number, number], rerolls: [1, 2] as [number, number] },
  { kind: 'whale' as OwnerKind, w: 0.2, lam: [0.3, 1] as [number, number], target: [5, 10] as [number, number], rerolls: [2, 4] as [number, number] },
]
const RAIDERS = [
  { kind: 'bare', w: 0.25, p: 0.08, rerolls: [0, 0] as [number, number] },
  { kind: 'perk1', w: 0.35, p: 0.11, rerolls: [1, 1] as [number, number] },
  { kind: 'perkHunt', w: 0.25, p: 0.15, rerolls: [2, 3] as [number, number] },
  { kind: 'yolo', w: 0.15, p: 0.12, rerolls: [0, 3] as [number, number] },
]

type OwnerRec = {
  kind: OwnerKind
  invest: number
  bankPaid: number
  power: number
  ticket$: number
  exitWins: number
  exit: 'claim' | 'cleared'
  bankAtExit: number
}
type ClearRec = { wins: number; pot: number; paid: number }

function cumPower(v: Variant, wins: number): number {
  let p = 0
  for (let w = 1; w <= wins; w++) p += v.mint(w)
  return p
}
function claimPower(v: Variant, wins: number): number {
  const p = cumPower(v, wins)
  return v.taxTickets ? p * (1 - v.tax(wins)) : p
}
function ownerClaimPay(v: Variant, wins: number): number {
  return hardBankAfterKills(wins) * HARD.clearOwnerFrac * (1 - v.tax(wins))
}

function runWeek(v: Variant, seed: number, vppEst: number) {
  const rng = mulberry32(seed)
  let pool$ = 0
  let attempts = 0
  const owners: OwnerRec[] = []
  const clears: ClearRec[] = []
  const raiderSpend = new Float64Array(RAIDER_ACCOUNTS)
  const raiderPot = new Float64Array(RAIDER_ACCOUNTS)
  const raiderPower = new Float64Array(RAIDER_ACCOUNTS)

  for (let d = 0; d < DUNGEONS_PER_WEEK; d++) {
    const o = pick(rng, OWNERS)
    const lam = range(rng, o.lam)
    const target = range(rng, o.target)
    const createRr = rerollCostSum(irange(rng, o.rerolls))
    const invest = HARD.createCost + createRr
    pool$ += HARD.createFee + createRr

    let wins = 0
    let rec: OwnerRec | null = null
    while (!rec) {
      attempts++
      const r = pick(rng, RAIDERS)
      const rid = Math.floor(rng() * RAIDER_ACCOUNTS)
      const rr = rerollCostSum(irange(rng, r.rerolls))
      raiderSpend[rid] += HARD.entryCost + rr
      pool$ += HARD.entryToOwnerPool + rr
      const bankNow = hardBankAfterKills(wins) + HARD.entryToBank

      if (rng() < r.p) {
        const pot = bankNow * HARD.clearRaiderFrac
        pool$ += bankNow * HARD.clearFeeFrac
        raiderPot[rid] += pot
        raiderPower[rid] += cumPower(v, wins) * 0.9
        clears.push({ wins, pot, paid: HARD.entryCost + rr })
        rec = { kind: o.kind, invest, bankPaid: 0, power: 0, ticket$: 0, exitWins: wins, exit: 'cleared', bankAtExit: bankNow }
        break
      }

      wins++
      if (wins < v.lockWins) continue
      const bank = hardBankAfterKills(wins)
      const power = claimPower(v, wins)
      const vNow = ownerClaimPay(v, wins) + power * vppEst
      const vNext = ownerClaimPay(v, wins + 1) + claimPower(v, wins + 1) * vppEst
      const roiNow = vNow / invest
      const noise = 0.85 + 0.3 * rng()
      const risk = Math.min(0.95, lam * SHOWN_CLEAR_P)

      let claim = false
      if (wins >= HARD.maxLiveWins) claim = true
      // Disposition effect: people rarely lock in a loss — only occasional panic.
      // Panic odds scale with how much is salvaged (nobody panic-sells for pennies).
      else if (roiNow < 1) claim = rng() < 0.04 * roiNow
      else if (roiNow >= target && rng() < 0.6) claim = true
      else if (roiNow >= 1 && rng() < 0.02) claim = true
      else claim = (1 - risk) * vNext * noise <= vNow

      if (claim) {
        const pay = ownerClaimPay(v, wins)
        pool$ += bank - pay
        rec = { kind: o.kind, invest, bankPaid: pay, power, ticket$: 0, exitWins: wins, exit: 'claim', bankAtExit: bank }
      }
    }
    owners.push(rec)
  }

  const ownerPowerTotal = sum(owners.map((o) => o.power))
  const raiderPowerTotal = sum(Array.from(raiderPower))
  const totalPower = ownerPowerTotal + raiderPowerTotal
  const tpFrac = v.ticketPoolFrac ?? 1
  const vpp = totalPower > 0 ? (pool$ * tpFrac) / totalPower : 0
  for (const o of owners) o.ticket$ = o.power * vpp

  return { owners, clears, attempts, pool$, totalPower, ownerPowerTotal, raiderPowerTotal, vpp, raiderSpend, raiderPot, raiderPower }
}

function report(v: Variant) {
  let vppEst = 0.5
  type W = ReturnType<typeof runWeek>
  const kept: W[] = []
  for (let wk = 0; wk < WEEKS; wk++) {
    const res = runWeek(v, 0x9e3779b1 ^ (wk * 7919 + v.name.length * 104729), vppEst)
    vppEst = res.vpp > 0 ? 0.5 * vppEst + 0.5 * res.vpp : 0
    if (wk >= WARMUP_WEEKS) kept.push(res)
  }

  const owners = kept.flatMap((k) => k.owners)
  const clears = kept.flatMap((k) => k.clears)
  const attempts = sum(kept.map((k) => k.attempts))
  const pool$ = mean(kept.map((k) => k.pool$))
  const vpp = mean(kept.map((k) => k.vpp))
  const ownerTix = sum(owners.map((o) => o.ticket$))
  const raiderTix = sum(kept.map((k) => k.raiderPowerTotal * k.vpp))
  const ret = (o: OwnerRec) => o.bankPaid + o.ticket$
  const roi = (o: OwnerRec) => ret(o) / o.invest
  const aggRoi = (os: OwnerRec[]) => (os.length ? sum(os.map(ret)) / sum(os.map((o) => o.invest)) : 0)

  const raiderSpend = sum(kept.map((k) => sum(Array.from(k.raiderSpend))))
  const raiderPot = sum(kept.map((k) => sum(Array.from(k.raiderPot))))

  console.log(`\n══ ${v.name}`)
  console.log(
    `  клир за рейд ${pct(clears.length / attempts)} · рейдов на данж ${(attempts / owners.length).toFixed(1)} · данж зачищен ${pct(clears.length / owners.length)} · снят владельцем ${pct(1 - clears.length / owners.length)}`,
  )
  const claimed = owners.filter((o) => o.exit === 'claim')
  console.log(
    `  средняя победа при снятии ${mean(claimed.map((o) => o.exitWins)).toFixed(1)} · средняя победа при клире ${mean(clears.map((c) => c.wins)).toFixed(1)} · средний банк на выходе $${mean(owners.map((o) => o.bankAtExit)).toFixed(0)}`,
  )
  console.log(
    `  пул за неделю $${pool$.toFixed(0)} · $/билет ${vpp.toFixed(3)} · пул → владельцам ${pct(ownerTix / Math.max(1e-9, ownerTix + raiderTix))} / рейдерам ${pct(raiderTix / Math.max(1e-9, ownerTix + raiderTix))}`,
  )
  console.log(
    `  ВЛАДЕЛЕЦ в среднем ${x2(aggRoi(owners))} · в плюсе ${pct(owners.filter((o) => roi(o) >= 1).length / owners.length)} · ≥2× ${pct(owners.filter((o) => roi(o) >= 2).length / owners.length)} · ≥3× ${pct(owners.filter((o) => roi(o) >= 3).length / owners.length)}`,
  )
  for (const k of ['claimer', 'holder', 'whale'] as OwnerKind[]) {
    const os = owners.filter((o) => o.kind === k)
    const cl = os.filter((o) => o.exit === 'claim')
    console.log(
      `    ${k.padEnd(8)} ${x2(aggRoi(os))} · снял ${pct(cl.length / os.length)} · средняя победа снятия ${mean(cl.map((o) => o.exitWins)).toFixed(1)}`,
    )
  }
  const buckets: [string, (w: number) => boolean][] = [
    ['0–3', (w) => w <= 3],
    ['4–6', (w) => w >= 4 && w <= 6],
    ['7', (w) => w === 7],
    ['8–9', (w) => w >= 8 && w <= 9],
    ['10–12', (w) => w >= 10 && w <= 12],
    ['13+', (w) => w >= 13],
  ]
  console.log('  снятие на победе → доля снявших · x владельца (банк + билеты) · банк на руки · билеты $')
  for (const [label, f] of buckets) {
    const os = claimed.filter((o) => f(o.exitWins))
    if (!os.length) continue
    console.log(
      `    ${label.padEnd(6)} ${pct(os.length / claimed.length).padStart(6)} · ${x2(aggRoi(os)).padStart(7)} · $${mean(os.map((o) => o.bankPaid)).toFixed(0).padStart(4)} · $${mean(os.map((o) => o.ticket$)).toFixed(0)}`,
    )
  }
  console.log('  клир на победе → доля клиров · x рейдера (банк / вход $15)')
  for (const [label, f] of buckets) {
    const cs = clears.filter((c) => f(c.wins))
    if (!cs.length) continue
    console.log(
      `    ${label.padEnd(6)} ${pct(cs.length / clears.length).padStart(6)} · ${x2(mean(cs.map((c) => c.pot / HARD.entryCost))).padStart(7)}`,
    )
  }
  console.log(
    `  РЕЙДЕР: средний x при клире ${x2(mean(clears.map((c) => c.pot / HARD.entryCost)))} · возврат на всё потраченное ${x2((raiderPot + raiderTix) / raiderSpend)} (банк ${x2(raiderPot / raiderSpend)} + билеты ${x2(raiderTix / raiderSpend)})`,
  )
  const top = [...owners].sort((a, b) => b.ticket$ - a.ticket$)
  const top1 = sum(top.slice(0, Math.ceil(top.length * 0.01)).map((o) => o.ticket$))
  console.log(`  топ-1% владельцев забирают ${pct(top1 / Math.max(1e-9, ownerTix))} билетных $ владельцев`)

  if (v.mint(8) > 0 || v.tax(1) > 0) {
    console.log('  Что видит владелец (при $/билет из этой недели):')
    for (let w = 5; w <= 12; w++) {
      const now = ownerClaimPay(v, w) + claimPower(v, w) * vpp
      const next = ownerClaimPay(v, w + 1) + claimPower(v, w + 1) * vpp
      console.log(
        `    win ${String(w).padStart(2)}: снять $${now.toFixed(0).padStart(4)} (${x2(now / HARD.createCost)}) · ещё 1 рейд → $${next.toFixed(0).padStart(4)} (+${pct(next / now - 1)}) при риске 11%`,
      )
    }
  }
}

/** keep(w<7) = keep7 × r^(7−w); tax(w≥7) = (1−keep7) × d^(w−7). */
function makeTax(keep7: number, r: number, d: number) {
  return (w: number) => {
    if (w >= 7) return (1 - keep7) * Math.pow(d, w - 7)
    return 1 - keep7 * Math.pow(r, 7 - Math.max(1, w))
  }
}

function summarize(v: Variant, weeks: number, warmup: number) {
  let vppEst = 0.5
  const kept: ReturnType<typeof runWeek>[] = []
  for (let wk = 0; wk < weeks; wk++) {
    const res = runWeek(v, 0x9e3779b1 ^ (wk * 7919 + 31337), vppEst)
    vppEst = res.vpp > 0 ? 0.5 * vppEst + 0.5 * res.vpp : 0
    if (wk >= warmup) kept.push(res)
  }
  const owners = kept.flatMap((k) => k.owners)
  const claimed = owners.filter((o) => o.exit === 'claim')
  const clears = kept.flatMap((k) => k.clears)
  const ret = (o: OwnerRec) => o.bankPaid + o.ticket$
  const ownerTix = sum(owners.map((o) => o.ticket$))
  const top = [...owners].sort((a, b) => b.ticket$ - a.ticket$)
  const raiderSpend = sum(kept.map((k) => sum(Array.from(k.raiderSpend))))
  const raiderPot = sum(kept.map((k) => sum(Array.from(k.raiderPot))))
  const raiderTix = sum(kept.map((k) => k.raiderPowerTotal * k.vpp))
  return {
    ownerAvg: sum(owners.map(ret)) / sum(owners.map((o) => o.invest)),
    ownersInPlus: owners.filter((o) => ret(o) >= o.invest).length / owners.length,
    meanClaimWin: mean(claimed.map((o) => o.exitWins)),
    claimShare: claimed.length / owners.length,
    claim0to6: claimed.filter((o) => o.exitWins <= 6).length / claimed.length,
    claim8plus: claimed.filter((o) => o.exitWins >= 8).length / claimed.length,
    reach10: owners.filter((o) => o.exitWins >= 10).length / owners.length,
    reach15: owners.filter((o) => o.exitWins >= 15).length / owners.length,
    raiderX: mean(clears.map((c) => c.pot / HARD.entryCost)),
    raiderRet: (raiderPot + raiderTix) / raiderSpend,
    top1: sum(top.slice(0, Math.ceil(top.length * 0.01)).map((o) => o.ticket$)) / Math.max(1e-9, ownerTix),
    poolToOwners: ownerTix / Math.max(1e-9, ownerTix + raiderTix),
    holdersWithTickets: owners.filter((o) => o.power > 0).length / owners.length,
    pool$: mean(kept.map((k) => k.pool$)),
    roi15: owners.filter((o) => ret(o) / o.invest >= 15).length / owners.length,
    roi30: owners.filter((o) => ret(o) / o.invest >= 30).length / owners.length,
    maxRoi: Math.max(...owners.map((o) => ret(o) / o.invest)),
    vpp: mean(kept.map((k) => k.vpp)),
  }
}

function search() {
  const ref = summarize({ name: 'V6', lockWins: 7, tax: () => 0, mint: smoothMint }, 6, 2)
  console.log(
    `Цель (V6 lock 7): снятие ${ref.meanClaimWin.toFixed(2)} · 8+ ${pct(ref.claim8plus)} · владелец ${x2(ref.ownerAvg)}\n`,
  )
  const rows: { tag: string; s: ReturnType<typeof summarize>; score: number }[] = []
  for (const taxTickets of [false, true])
    for (const keep7 of [0.8, 0.85, 0.9, 0.95])
      for (const r of [0.15, 0.2, 0.25, 0.3, 0.35, 0.45])
        for (const d of [0.4, 0.7]) {
          const tax = makeTax(keep7, r, d)
          const s = summarize({ name: 'grid', lockWins: 0, tax, mint: smoothMint, taxTickets }, 6, 2)
          const score =
            Math.abs(s.meanClaimWin - ref.meanClaimWin) +
            10 * Math.abs(s.claim8plus - ref.claim8plus) +
            Math.abs(s.ownerAvg - ref.ownerAvg)
          rows.push({ tag: `${taxTickets ? 'bank+tix' : 'bank'} keep7=${keep7} r=${r} d=${d}`, s, score })
        }
  rows.sort((a, b) => a.score - b.score)
  for (const { tag, s, score } of rows.slice(0, 8)) {
    console.log(
      `${tag.padEnd(26)} score ${score.toFixed(2)} · снятие ${s.meanClaimWin.toFixed(2)} · 8+ ${pct(s.claim8plus)} · 0–6 ${pct(s.claim0to6)} · владелец ${x2(s.ownerAvg)} · до 15 ${pct(s.reach15)}`,
    )
  }
}

function final() {
  const best = makeTax(
    Number(process.env.KEEP7 ?? 0.9),
    Number(process.env.R ?? 0.55),
    Number(process.env.D ?? 0.4),
  )
  console.log('Налог по победам:')
  console.log(
    '  ' +
      Array.from({ length: 12 }, (_, i) => i + 1)
        .map((w) => `w${w} ${(100 * best(w)).toFixed(0)}%`)
        .join(' · '),
  )
  const vs: Variant[] = [
    { name: 'V0 сейчас: lock 7, без билетов', lockWins: 7, tax: () => 0, mint: () => 0 },
    { name: 'V6 lock 7 + сглаженные билеты', lockWins: 7, tax: () => 0, mint: smoothMint },
    {
      name: 'V7 подобранный налог + сглаженные билеты (без запрета)',
      lockWins: 0,
      tax: best,
      mint: smoothMint,
      taxTickets: process.env.TT !== '0',
    },
    {
      name: 'V8 мягкий блок 80→0% + медленный минт',
      lockWins: 0,
      tax: softRoundTax,
      mint: slowLinMint,
    },
    {
      name: 'V9 мягкий блок 95→0% + сглаженный минт',
      lockWins: 0,
      tax: nearLockTax,
      mint: smoothMint,
    },
    {
      name: 'V10 95→0% + survival-минт (frac 1.5%) — win7≈3× win25≈15×',
      lockWins: 0,
      tax: nearLockTax,
      mint: survivalMint,
      ticketPoolFrac: 0.015,
    },
  ]
  for (const v of vs) {
    const s = summarize(v, 10, 2)
    console.log(`\n══ ${v.name}`)
    console.log(
      `  владелец ${x2(s.ownerAvg)} · в плюсе ${pct(s.ownersInPlus)} · снимают ${pct(s.claimShare)} · средняя победа снятия ${s.meanClaimWin.toFixed(2)} · снятий 0–6 ${pct(s.claim0to6)} · 8+ ${pct(s.claim8plus)}`,
    )
    console.log(
      `  дожили до 10 ${pct(s.reach10)} · до 15 ${pct(s.reach15)} · владельцев с билетами ${pct(s.holdersWithTickets)} · пул/нед $${s.pool$.toFixed(0)} · $/билет ${s.vpp.toFixed(2)}`,
    )
    console.log(
      `  ≥15× ${pct(s.roi15)} · ≥30× ${pct(s.roi30)} · макс ${x2(s.maxRoi)} · рейдер × при клире ${x2(s.raiderX)} · возврат с $ ${s.raiderRet.toFixed(2)}`,
    )
  }
  console.log('\n── Что видит владелец при каждом варианте (банк + ожидаемые билеты):')
  for (const vx of vs.slice(1)) {
    const svx = summarize(vx, 10, 2)
    const vppx = svx.vpp
    console.log(`\n  ${vx.name}`)
    console.log('  win | tax  | банк  | билеты | итого | Х    | +рейд | рейдер×')
    for (let w = 1; w <= 16; w++) {
      const bank = hardBankAfterKills(w)
      const kept = bank * HARD.clearOwnerFrac * (1 - vx.tax(w))
      const tix = claimPower(vx, w) * vppx
      const total = kept + tix
      const roi = total / HARD.createCost
      const bankNext = hardBankAfterKills(w + 1)
      const keptNext = bankNext * HARD.clearOwnerFrac * (1 - vx.tax(w + 1))
      const tixNext = claimPower(vx, w + 1) * vppx
      const totalNext = keptNext + tixNext
      const raiderX = (bank + HARD.entryToBank) * HARD.clearRaiderFrac / HARD.entryCost
      const ra = raiderX >= 10 ? '≥10×' : raiderX >= 8 ? '8–10×' : `${raiderX.toFixed(1)}×`
      const mark = roi >= 15 ? ' ★15×!' : roi >= 10 ? ' ★10×' : ''
      console.log(
        `  w${String(w).padStart(2)}: ${(vx.tax(w) * 100).toFixed(0).padStart(3)}%  $${kept.toFixed(0).padStart(4)}  $${tix.toFixed(0).padStart(5)}  $${total.toFixed(0).padStart(5)}  ${roi.toFixed(1).padStart(4)}×  +${pct(totalNext / total - 1).padStart(5)}  ${ra}${mark}`,
      )
    }
  }
  console.log('')
  const vpp8 = summarize(vs[vs.length - 1]!, 10, 2).vpp
  const v8 = vs[vs.length - 1]!
  console.log('  win | tax | банк руки | билеты | итого | Х create | +если выживет |  риск 11%')
  for (let w = 1; w <= 18; w++) {
    const bank = hardBankAfterKills(w)
    const kept = bank * HARD.clearOwnerFrac * (1 - v8.tax(w))
    const tix = claimPower(v8, w) * vpp8
    const total = kept + tix
    const roi = total / HARD.createCost
    const bankNext = hardBankAfterKills(w + 1)
    const keptNext = bankNext * HARD.clearOwnerFrac * (1 - v8.tax(w + 1))
    const tixNext = claimPower(v8, w + 1) * vpp8
    const totalNext = keptNext + tixNext
    const raiderX = (bank + HARD.entryToBank) * HARD.clearRaiderFrac / HARD.entryCost
    const marker = raiderX >= 8 && raiderX < 10 ? ' ← рейдер 8–10×' : raiderX >= 10 ? ' ← рейдер ≥10×' : ''
    console.log(
      `  w${String(w).padStart(2)} | ${(v8.tax(w) * 100).toFixed(0).padStart(2)}% | $${kept.toFixed(0).padStart(4)} | $${tix.toFixed(0).padStart(4)} | $${total.toFixed(0).padStart(4)} | ${roi.toFixed(1).padStart(5)}× | +${pct(totalNext / total - 1).padStart(6)}${marker}`,
    )
  }
  console.log('')
  report(vs[vs.length - 1]!)
}

function search2() {
  console.log('Поиск ticketPoolFrac для V8 (roundTax + slowLinMint): цель — 15× появляется на победе 15–20, roi15 ≈ 2–3%\n')

  // Analytical estimate: at which win does bank+tickets first reach 15× for a given frac?
  function winAt15x(frac: number, s: ReturnType<typeof summarize>): number {
    const tpv = s.vpp > 0 ? s.vpp : 1
    for (let w = 1; w <= 40; w++) {
      const bank = hardBankAfterKills(w) * HARD.clearOwnerFrac * (1 - roundTax(w))
      const tix = claimPower({ name: '', lockWins: 0, tax: roundTax, mint: slowLinMint }, w) * tpv * frac
      if ((bank + tix) / HARD.createCost >= 15) return w
    }
    return 99
  }

  for (const frac of [0.05, 0.08, 0.10, 0.13, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 0.70, 1.0]) {
    const v: Variant = { name: 'grid', lockWins: 0, tax: roundTax, mint: slowLinMint, ticketPoolFrac: frac }
    const s = summarize(v, 8, 2)
    const w15 = winAt15x(frac, s)
    console.log(
      `frac ${String(frac).padEnd(4)} $/тик $${s.vpp.toFixed(1).padStart(5)} · 15× на win ${String(w15).padStart(2)} · roi15 ${pct(s.roi15)} · roi30 ${pct(s.roi30)} · владелец ${x2(s.ownerAvg)} · снятие win ${s.meanClaimWin.toFixed(1)}`,
    )
  }
}

if (process.argv.includes('--search')) search()
else if (process.argv.includes('--search2')) search2()
else if (process.argv.includes('--final')) final()
else {
  console.log(
    `Hard hold-curve sim · ${DUNGEONS_PER_WEEK} данжей/неделю · ${RAIDER_ACCOUNTS} рейдеров · ${WEEKS - WARMUP_WEEKS} недель в отчёте`,
  )
  for (const v of VARIANTS) report(v)
}
