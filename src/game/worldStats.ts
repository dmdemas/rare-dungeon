/**
 * Dashboard numbers derived from the pre-simulated world (live dungeons +
 * replayed pool inflow) and the offline world-sim report.
 */
import {
  HARD,
  PROTOCOL_WEEKLY_BURN_FRAC,
  SOFT,
  TICKET,
  TICKET_POOL_FRAC,
  settleHardClaimWithTax,
  settleSoftClaim,
  type DungeonTier,
} from './economy'
import type { DungeonBlueprint } from './types'

/**
 * `npm run gen:world` report, 4 independent runs (docs/economy-research/08).
 * Ranges are min–max across runs.
 */
export const WORLD_SIM_REPORT = {
  soft: { clearRate: [0.299, 0.33], raiderX: 3.0, raiderHeldX: null, ownerCloseRoi: 1.86 },
  hard: { clearRate: [0.085, 0.096], raiderX: 5.2, raiderHeldX: [8.7, 9.4], ownerCloseRoi: 3.95 },
} as const

/** Hard dungeons at or past the first ticket-minting win are "held". */
export const HELD_WINS = 7

export type TierLiveStats = {
  live: number
  totalBank: number
  avgBank: number
  maxBank: number
  avgWins: number
  maxWins: number
  /** Best raider × vs entry among live dungeons if cleared now. */
  bestX: number
  avgX: number
  held: number
  tickets: number
}

export function tierLiveStats(
  pool: DungeonBlueprint[],
  tier: DungeonTier,
  entryCost: number,
): TierLiveStats {
  const cfg = tier === 'hard' ? HARD : SOFT
  const live = pool.filter((d) => (d.tier ?? 'soft') === tier && d.status !== 'closed')
  const banks = live.map((d) => d.bank ?? cfg.createToBank)
  const totalBank = banks.reduce((s, b) => s + b, 0)
  const maxBank = banks.reduce((m, b) => Math.max(m, b), 0)
  const wins = live.map((d) => d.wins ?? 0)
  const n = Math.max(1, live.length)
  const xIfEntered = (bank: number) => raiderWinMult(bankWithEntry(bank, tier, entryCost), tier, entryCost)
  return {
    live: live.length,
    totalBank,
    avgBank: totalBank / n,
    maxBank,
    avgWins: wins.reduce((s, w) => s + w, 0) / n,
    maxWins: wins.reduce((m, w) => Math.max(m, w), 0),
    bestX: xIfEntered(maxBank),
    avgX: xIfEntered(totalBank / n),
    held: wins.filter((w) => w >= HELD_WINS).length,
    tickets: live.reduce((s, d) => s + (d.ticketPower ?? 0), 0),
  }
}

/** Raider × vs paid entry if the dungeon is cleared at this bank. */
export function raiderWinMult(bank: number, tier: DungeonTier, paid: number): number {
  const cfg = tier === 'hard' ? HARD : SOFT
  return (bank * cfg.clearRaiderFrac) / Math.max(1e-9, paid)
}

/** Bank once this raider's entry is in (what the raid itself shows). */
export function bankWithEntry(bank: number, tier: DungeonTier, entryCost: number): number {
  const cfg = tier === 'hard' ? HARD : SOFT
  return bank + entryCost * (cfg.entryToBank / cfg.entryCost)
}

/** Owner payout if closing now (Hard: near-lock tax applied). */
export function closeNowPayout(bp: DungeonBlueprint): { payout: number; taxFrac: number } {
  const tier = bp.tier ?? 'soft'
  const cfg = tier === 'hard' ? HARD : SOFT
  const bank = bp.bank ?? cfg.createToBank
  const wins = bp.wins ?? 0
  const shares = bp.sharesAccrued ?? 0
  if (tier === 'hard') {
    const c = settleHardClaimWithTax(bank, wins)
    return { payout: c.ownerPayout + shares, taxFrac: bank > 0 ? c.taxed / bank : 0 }
  }
  return { payout: settleSoftClaim(bank, wins).ownerPayout + shares, taxFrac: 0 }
}

/** Invested vs current value (withdrawn + close-now of live) for the owner's dungeons. */
export function ownerPortfolio(owned: DungeonBlueprint[]) {
  let invested = 0
  let value = 0
  let tickets = 0
  for (const d of owned) {
    invested += d.invested ?? 0
    value += d.withdrawn ?? 0
    if (d.status !== 'closed') value += closeNowPayout(d).payout
    tickets += d.ticketPower ?? 0
  }
  const roi = invested > 0 ? value / invested : 0
  return { invested, value, roi, profitPct: invested > 0 ? (roi - 1) * 100 : 0, tickets }
}

/** Replayed pool inflow grouped into `buckets` bars ($ per bar). */
export function poolInflowSeries(poolCents: number[], buckets: number): number[] {
  const size = Math.max(1, Math.ceil(poolCents.length / buckets))
  const out: number[] = []
  for (let i = 0; i < poolCents.length; i += size) {
    let s = 0
    for (let j = i; j < Math.min(poolCents.length, i + size); j++) s += poolCents[j]!
    out.push(s / 100)
  }
  return out
}

export type DayBar = {
  week: 'prev' | 'cur' | 'next'
  /** 0 = Monday. */
  day: number
  value: number
  kind: 'past' | 'today' | 'future'
}

/** Days shown from the previous / next week around the current one. */
const EDGE_DAYS = 2

/**
 * Daily pool inflow around the current week (`today` = weekday, 0 = Monday).
 * Past days: `baselineDaily` shaped by the replayed world raids, this week's
 * past days averaging `baselineDaily`. Today and future days: the average of
 * the past days — a day's bar only takes its real height once the day is over.
 */
export function weekInflowBars(opts: { today: number; baselineDaily: number; poolCents: number[] }): DayBar[] {
  const { today, baselineDaily, poolCents } = opts
  const pastDays = EDGE_DAYS + today
  const shape = poolInflowSeries(poolCents, pastDays)
  const norm = (xs: number[]) => {
    const mean = xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
    return xs.map((x) => (mean > 0 ? (baselineDaily * x) / mean : baselineDaily))
  }
  const prev = norm(shape.slice(0, EDGE_DAYS))
  const cur = norm(shape.slice(EDGE_DAYS, pastDays))
  const past = [...prev, ...cur]
  const avg = past.reduce((s, x) => s + x, 0) / Math.max(1, past.length)

  const bars: DayBar[] = prev.map((value, i) => ({ week: 'prev', day: 7 - EDGE_DAYS + i, value, kind: 'past' }))
  for (let d = 0; d < 7; d++) {
    if (d < today) bars.push({ week: 'cur', day: d, value: cur[d]!, kind: 'past' })
    else bars.push({ week: 'cur', day: d, value: avg, kind: d === today ? 'today' : 'future' })
  }
  for (let d = 0; d < EDGE_DAYS; d++) bars.push({ week: 'next', day: d, value: avg, kind: 'future' })
  return bars
}

/** Player's projected week-end ticket payout at the current pool size. */
export function projectedTicketPayout(pool$: number, playerPower: number, aiPower: number) {
  const ticketPot = pool$ * (1 - PROTOCOL_WEEKLY_BURN_FRAC) * TICKET_POOL_FRAC
  const total = playerPower + aiPower
  return {
    ticketPot,
    share: total > 0 ? playerPower / total : 0,
    payout: total > 0 ? (ticketPot * playerPower) / total : 0,
    perTicket: total > 0 ? ticketPot / total : 0,
  }
}

/** Raider's cut of a dungeon's tickets on a clear (Hard only). */
export function ticketsOnClear(ticketPower: number): number {
  return ticketPower * TICKET.wipeToFriendFrac
}
