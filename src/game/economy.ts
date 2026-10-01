/**
 * Soft / Hard economy — wallet, stake splits, pool drip math, claim helpers.
 * Canon: economy.md + .cursor/rules/soft-hard-economy.mdc
 */
import type { DungeonBlueprint } from './types'

export type DungeonTier = 'soft' | 'hard'

export type WalletState = {
  balance: number
  spent: number
  burned: number
  treasure: number
  rewardPool: number
}

export const POOL_SOFT_FRAC = 0.2
export const POOL_HARD_FRAC = 0.8

/**
 * Soft dungeon units = 1 (player-facing). Absolute combat power of one unit =
 * historical Soft scale 0.4 — balance unchanged.
 * Hard units = former Hard abs 0.92 / 0.4 = 2.3 → abs still 0.92.
 */
export const DUNGEON_SCALE_UNIT_ABS = 0.4

/** Soft: cheap school tier. Clear ~30–34%. Close ~1.5× bank. No rerolls. */
export const SOFT = {
  createCost: 2,
  createToBank: 1.5,
  createFee: 0.5,
  entryCost: 1,
  /** Mirror Hard 90/10 of paid entry → bank / owner pool. */
  entryToBank: 0.9,
  entryToOwnerPool: 0.1,
  entryToProtocol: 0,
  clearRaiderFrac: 0.95,
  clearFeeFrac: 0.05,
  /** Owner claim gets same 95%; fee 5% → protocol. */
  clearOwnerFrac: 0.95,
  suggestedCloseRoi: 1.5,
  minWinsBeforeClaim: 0,
  maxLiveWins: 15,
  targetClearP: 0.32,
  /** Relative dungeon units (Soft = 1). Combat abs = units × DUNGEON_SCALE_UNIT_ABS. */
  dungeonPowerScale: 1,
  /** Soft ease: −10 fright. Stamina base 20 via SOFT_FLOOR_STAMINA. */
  friendStaminaBonus: 0,
  friendFrightCut: 10,
  friendDodgeFloor: 0,
  /** Soft-only mul on dungeon perk scale. 1 = no boost (version 3 baseline). */
  dungeonEfficacy: 6.5,
} as const

  /**
   * Soft Friend STA — flat 20 all floors (Easy baseline, same as Hard F1).
   * No extra staminaBonus from softEase; Endurance perk adds on top.
   */
export const SOFT_FLOOR_STAMINA = [0, 20, 20, 20] as const

export function softFloorStamina(floor: number): number {
  const f = Math.min(3, Math.max(1, Math.floor(floor)))
  return SOFT_FLOOR_STAMINA[f]!
}

/** Hard: fat pot + rerolls. Clear ~11%. No hard lock — near-lock tax replaces it. */
export const HARD = {
  createCost: 30,
  /** 90% locks in dungeon bank; 10% create fee → rewardPool. */
  createToBank: 27,
  createFee: 3,
  entryCost: 15,
  entryToBank: 13.5,
  entryToOwnerPool: 1.5,
  entryToProtocol: 0,
  clearRaiderFrac: 0.95,
  clearFeeFrac: 0.05,
  clearOwnerFrac: 0.95,
  /** Suggest closing when net-of-tax ROI ≥ 3.5× (reachable at win 8 with tax = 0). */
  suggestedCloseRoi: 3.5,
  /** No hard lock — economic lock via claimTaxFrac(). */
  minWinsBeforeClaim: 0,
  maxLiveWins: 40,
  targetClearP: 0.1,
  /** Friend + dungeon create: $2.5 then ×1.5 → 100% rewardPool. */
  rerollBase: 2.5,
  rerollGrowth: 1.5,
  /** Relative Soft-units: 0.92/0.4 = 2.3. Combat abs = 2.3 × 0.4 = 0.92 (unchanged). */
  dungeonPowerScale: 2.3,
  friendStaminaBonus: 0,
  friendFrightCut: 0,
  friendDodgeFloor: 0,
} as const

/**
 * Hard floor stamina only (old combat rules otherwise: scale 0.92, no fright ease).
 * F1 soft landing via higher STA; later floors drain the budget.
 * Target cum die ~30/60/90, clear ~10% — tune via `npm run sim:hard-floors`.
 */
export const HARD_FLOOR_STAMINA = [0, 20, 17, 13] as const

/**
 * Stamina used for the headless "Simulate raids" preview (slightly easier than real play).
 * F1: 20  F2: 18  F3: 16
 */
export const HARD_SIM_FLOOR_STAMINA = [0, 20, 18, 16] as const

export function hardSimFloorStamina(floor: number): number {
  const f = Math.min(3, Math.max(1, Math.floor(floor)))
  return HARD_SIM_FLOOR_STAMINA[f]!
}

export function hardFloorStamina(floor: number): number {
  const f = Math.min(3, Math.max(1, Math.floor(floor)))
  return HARD_FLOOR_STAMINA[f]!
}

/** Absolute combat scale fed into perk math (Soft 0.4, Hard 0.92). */
export function absoluteDungeonPowerScale(tier: DungeonTier): number {
  const units = tier === 'hard' ? HARD.dungeonPowerScale : SOFT.dungeonPowerScale
  // Keep legacy abs exact (2.3 * 0.4 → float noise otherwise).
  return Math.round(units * DUNGEON_SCALE_UNIT_ABS * 100) / 100
}

/** Player-facing Soft-units (Soft 1, Hard 2.3). */
export function dungeonPowerUnits(tier: DungeonTier): number {
  return tier === 'hard' ? HARD.dungeonPowerScale : SOFT.dungeonPowerScale
}

export function dungeonPowerLabel(tier: DungeonTier): string {
  const u = dungeonPowerUnits(tier)
  return `${u}× dungeon`
}

type WrapOpts = { owned?: boolean; name?: string }

export function createWallet(startBalance: number): WalletState {
  return {
    balance: startBalance,
    spent: 0,
    burned: 0,
    treasure: 0,
    rewardPool: 0,
  }
}

export function credit(w: WalletState, amount: number): WalletState {
  if (amount <= 0) return w
  return { ...w, balance: w.balance + amount }
}

function debit(w: WalletState, amount: number): WalletState | null {
  if (amount < 0 || w.balance < amount) return null
  return { ...w, balance: w.balance - amount, spent: w.spent + amount }
}

/**
 * Fees → rewardPool (anti early-claim: hold for shares).
 * Burn/treasure split is OFF for now — flip PROTOCOL_BURN_ENABLED to restore 50/50.
 */
export const PROTOCOL_BURN_ENABLED = false

export function applyProtocolFee(w: WalletState, fee: number): WalletState {
  if (fee <= 0) return w
  if (!PROTOCOL_BURN_ENABLED) {
    return { ...w, rewardPool: w.rewardPool + fee }
  }
  const half = fee / 2
  return {
    ...w,
    burned: w.burned + half,
    treasure: w.treasure + half,
  }
}

function addToPool(w: WalletState, amount: number): WalletState {
  if (amount <= 0) return w
  return { ...w, rewardPool: w.rewardPool + amount }
}

// ── Weekly pool tickets (one ticket type; power = quantity) ─────────────

/**
 * Canon targets (Hard OR):
 * - Friend wipe on held bank (k≥7) ~8–10× entry
 * - Owner total (bank claim + weekly ticket $) ~2–3× create (tickets push hold; early claim slashed)
 * Wipe transfer W2 (90% Friend / 10% burn) — mint pulled back vs v1 (risk×4 / post×3 / hold0.15 / burn30%).
 */
export const TICKET = {
  softPoolFrac: POOL_SOFT_FRAC,
  hardPoolFrac: POOL_HARD_FRAC,
  /** Red zone / jackpot band — mint + riskBoost (v1 was risk×4 / post×3). */
  riskWins: 8,
  riskRaiderX: 7,
  riskBoost: 3,
  /** Extra mint mult once wins ≥ unlockWins (anti early-claim). */
  unlockWins: 8,
  postUnlockMint: 2,
  holdBonusPerWin: 0.12,
  accountBonusPerExtra: 0.08,
  accountBonusCap: 1.35,
  /**
   * Claim before unlockWins: keep only this fraction of that dungeon's ticket power.
   * Rest burned — makes k=7 claim weak vs holding into 8–10× band.
   */
  earlyClaimKeepFrac: 0.2,
  wipeToFriendFrac: 0.9,
  wipeBurnFrac: 0.1,
  /** Suggested holder exit when raider× hits this (sim / AI owners). */
  holderExitRaiderX: 9.2,
  holderExitWins: 12,
} as const

/** One inventory ticket per player per week — only `power` changes (not levels). */
export type PoolTicket = {
  ownerId: string
  /** Accumulated power (quantity). */
  power: number
  /** Power still attributed to a live dungeon (transferable on wipe). */
  byDungeon: Record<string, number>
}

export function createTicket(ownerId: string): PoolTicket {
  return { ownerId, power: 0, byDungeon: {} }
}

export function ticketHoldBonus(winsAfterKill: number): number {
  return 1 + TICKET.holdBonusPerWin * Math.max(0, winsAfterKill - 1)
}

export function ticketRiskBoost(winsAfterKill: number, raiderMultIfWipedNow: number): number {
  if (winsAfterKill >= TICKET.riskWins || raiderMultIfWipedNow >= TICKET.riskRaiderX) {
    return TICKET.riskBoost
  }
  return 1
}

export function ticketPostUnlockMint(winsAfterKill: number): number {
  return winsAfterKill >= TICKET.unlockWins ? TICKET.postUnlockMint : 1
}

export function ticketAccountMult(liveHardOwned: number): number {
  const extra = Math.max(0, liveHardOwned - 1)
  return Math.min(TICKET.accountBonusCap, 1 + TICKET.accountBonusPerExtra * extra)
}

/** Raider × if they cleared at this bank (95% pot / entry). */
export function hardRaiderMultAtBank(bank: number, paidEntry: number = HARD.entryCost): number {
  return (bank * HARD.clearRaiderFrac) / Math.max(1e-9, paidEntry)
}

/**
 * Power minted when a Hard dungeon wins a raid (corpse).
 * `winsAfterKill` = wins count after this corpse is counted.
 */
export function ticketPowerOnCorpse(opts: {
  winsAfterKill: number
  bankAfterKill: number
  liveHardOwned?: number
  paidEntry?: number
}): number {
  const mult = hardRaiderMultAtBank(opts.bankAfterKill, opts.paidEntry)
  const raw =
    1 *
    ticketHoldBonus(opts.winsAfterKill) *
    ticketRiskBoost(opts.winsAfterKill, mult) *
    ticketPostUnlockMint(opts.winsAfterKill) *
    ticketAccountMult(opts.liveHardOwned ?? 1)
  return Math.round(raw * 1000) / 1000
}

export function addTicketPower(
  ticket: PoolTicket,
  dungeonId: string,
  delta: number,
): PoolTicket {
  if (delta <= 0) return ticket
  const prev = ticket.byDungeon[dungeonId] ?? 0
  return {
    ...ticket,
    power: ticket.power + delta,
    byDungeon: { ...ticket.byDungeon, [dungeonId]: prev + delta },
  }
}

/**
 * Early claim slash: before unlockWins, keep only earlyClaimKeepFrac of dungeon power.
 * Then lock (byDungeon cleared — power stays on owner until week end).
 */
export function slashTicketsOnEarlyClaim(
  ticket: PoolTicket,
  dungeonId: string,
  wins: number,
): PoolTicket {
  const attributed = ticket.byDungeon[dungeonId] ?? 0
  if (attributed <= 0) return lockTicketsOnClaim(ticket, dungeonId)
  if (wins >= TICKET.unlockWins) return lockTicketsOnClaim(ticket, dungeonId)
  const keep = attributed * TICKET.earlyClaimKeepFrac
  const lost = attributed - keep
  const { [dungeonId]: _, ...rest } = ticket.byDungeon
  const next: PoolTicket = {
    ...ticket,
    power: Math.max(0, ticket.power - lost),
    byDungeon: rest,
  }
  return lockTicketsOnClaim(next, dungeonId)
}

/**
 * Wipe: move dungeon-attributed power to Friend (W2).
 * Returns updated owner ticket, friend ticket, and burned power.
 */
export function transferTicketsOnWipe(
  ownerTicket: PoolTicket,
  friendTicket: PoolTicket,
  dungeonId: string,
): { owner: PoolTicket; friend: PoolTicket; transferred: number; burned: number } {
  const attributed = ownerTicket.byDungeon[dungeonId] ?? 0
  if (attributed <= 0) {
    const { [dungeonId]: _, ...rest } = ownerTicket.byDungeon
    return {
      owner: { ...ownerTicket, byDungeon: rest },
      friend: friendTicket,
      transferred: 0,
      burned: 0,
    }
  }
  const toFriend = attributed * TICKET.wipeToFriendFrac
  const burned = attributed * TICKET.wipeBurnFrac
  const { [dungeonId]: _, ...rest } = ownerTicket.byDungeon
  return {
    owner: {
      ...ownerTicket,
      power: Math.max(0, ownerTicket.power - attributed),
      byDungeon: rest,
    },
    friend: {
      ...friendTicket,
      power: friendTicket.power + toFriend,
      // Friend's transferred power is pocketed (not on a dungeon) — empty key bucket
      byDungeon: friendTicket.byDungeon,
    },
    transferred: toFriend,
    burned,
  }
}

/** Claim: bank now; ticket power stays until week end (byDungeon cleared — locked to owner). */
export function lockTicketsOnClaim(ticket: PoolTicket, dungeonId: string): PoolTicket {
  const { [dungeonId]: _, ...rest } = ticket.byDungeon
  return { ...ticket, byDungeon: rest }
}

export type WeekSettlement = {
  potSoft: number
  potHard: number
  payouts: { ownerId: string; power: number; payout: number }[]
}

/**
 * End of week: split pool 20/80 Soft/Hard by ticket ledgers, pay pro-rata power, clear tickets.
 * Soft/Hard ticket maps are separate inventories for the epoch.
 */
export function settleWeekPool(
  pool$: number,
  softTickets: PoolTicket[],
  hardTickets: PoolTicket[],
): WeekSettlement {
  const potSoft = pool$ * TICKET.softPoolFrac
  const potHard = pool$ * TICKET.hardPoolFrac
  const payouts: WeekSettlement['payouts'] = []

  const paySide = (pot: number, tickets: PoolTicket[]) => {
    const totalPower = tickets.reduce((s, t) => s + t.power, 0)
    if (totalPower <= 0 || pot <= 0) return
    for (const t of tickets) {
      if (t.power <= 0) continue
      payouts.push({
        ownerId: t.ownerId,
        power: t.power,
        payout: (pot * t.power) / totalPower,
      })
    }
  }
  paySide(potSoft, softTickets)
  paySide(potHard, hardTickets)
  return { potSoft, potHard, payouts }
}

/** Cost of the next reroll after `already` prior rerolls (0 → $2.5, 1 → $3.75, …). */
export function rerollCost(already: number): number {
  return HARD.rerollBase * Math.pow(HARD.rerollGrowth, Math.max(0, already))
}

/** Sum of costs for the first `n` rerolls. */
export function rerollCostSum(n: number): number {
  let s = 0
  const count = Math.max(0, Math.floor(n))
  for (let i = 0; i < count; i++) s += rerollCost(i)
  return s
}

/**
 * Split an epoch pool inflow across live Soft/Hard dungeons (20/80).
 * Returns per-dungeon share for each tier.
 */
export function distributePoolEpoch(
  amount: number,
  liveSoft: number,
  liveHard: number,
): { softPot: number; hardPot: number; softPerDungeon: number; hardPerDungeon: number } {
  const softPot = amount * POOL_SOFT_FRAC
  const hardPot = amount * POOL_HARD_FRAC
  return {
    softPot,
    hardPot,
    softPerDungeon: liveSoft > 0 ? softPot / liveSoft : 0,
    hardPerDungeon: liveHard > 0 ? hardPot / liveHard : 0,
  }
}

export type EntryQuote = {
  mul: number
  cost: number
  toBank: number
  toPool: number
}

/**
 * Raid pressure → entry discount (Hard raid-glut lever; Soft stays mul=1 in product).
 * pressure = raidDemand / liveHard
 * ≤1.1 → 1 · ≤2 → 0.75 · ≤3 → 0.6 · else 0.5
 */
export function entryMulFromPressure(pressure: number): number {
  if (pressure <= 1.1) return 1
  if (pressure <= 2) return 0.75
  if (pressure <= 3) return 0.6
  return 0.5
}

/**
 * App proxy: Soft live ≈ raid pipeline demand vs Hard supply.
 * Create-glut (many Hard, few Soft) → low pressure → full price.
 * Raid-glut (few Hard, many Soft) → discount.
 */
export function hardPressureFromLive(liveSoft: number, liveHard: number): number {
  return Math.max(0, liveSoft) / Math.max(1, liveHard)
}

/** Paid entry keeps 90/10 bank/pool of the *paid* stake (same ratios as $13.5+$1.5 of $15). */
export function quoteHardEntry(entryMul = 1): EntryQuote {
  const mul = Math.max(0, entryMul)
  const cost = HARD.entryCost * mul
  const toBank = cost * (HARD.entryToBank / HARD.entryCost)
  const toPool = cost * (HARD.entryToOwnerPool / HARD.entryCost)
  return { mul, cost, toBank, toPool }
}

export function quoteSoftEntry(entryMul = 1): EntryQuote {
  const mul = Math.max(0, entryMul)
  const cost = SOFT.entryCost * mul
  const toBank = cost * (SOFT.entryToBank / SOFT.entryCost)
  const toPool = cost * (SOFT.entryToOwnerPool / SOFT.entryCost)
  return { mul, cost, toBank, toPool }
}

/** Canonical Soft/Hard prices at parity (mul=1) — UI table. */
export function parityPriceTable() {
  const soft = quoteSoftEntry(1)
  const hard = quoteHardEntry(1)
  return {
    soft: {
      create: SOFT.createCost,
      createBank: SOFT.createToBank,
      createFee: SOFT.createFee,
      entry: soft.cost,
      entryBank: soft.toBank,
      entryPool: soft.toPool,
      suggestedCloseRoi: SOFT.suggestedCloseRoi,
      targetClearP: SOFT.targetClearP,
      minWinsBeforeClaim: SOFT.minWinsBeforeClaim,
    },
    hard: {
      create: HARD.createCost,
      createBank: HARD.createToBank,
      createFee: HARD.createFee,
      entry: hard.cost,
      entryBank: hard.toBank,
      entryPool: hard.toPool,
      suggestedCloseRoi: HARD.suggestedCloseRoi,
      targetClearP: HARD.targetClearP,
      minWinsBeforeClaim: HARD.minWinsBeforeClaim,
    },
  }
}

export function softBankAfterKills(kills: number, bankAddPerKill = SOFT.entryToBank): number {
  return SOFT.createToBank + Math.max(0, kills) * bankAddPerKill
}

export function hardBankAfterKills(kills: number, bankAddPerKill = HARD.entryToBank): number {
  return HARD.createToBank + Math.max(0, kills) * bankAddPerKill
}

/** P(dungeon still live after `raids` independent attempts). */
export function survivalChance(clearP: number, raids: number): number {
  const n = Math.max(0, Math.floor(raids))
  const p = Math.min(1, Math.max(0, clearP))
  return Math.pow(1 - p, n)
}

export type YieldProjection = {
  extraRaids: number
  bank: number
  wins: number
  ownerPayout: number
  ownerRoi: number
  raiderMult: number
  survival: number
  canClaim: boolean
}

/**
 * Owner yield if the next `extraRaids` all die (corpses → bank), before any clear.
 * Raider × vs *paid* entry (parity or discounted).
 */
export function projectYieldAfterRaids(
  tier: DungeonTier,
  opts: {
    bank: number
    wins: number
    shares?: number
    invested?: number
    extraRaids: number
    entryQuote?: EntryQuote
  },
): YieldProjection {
  const cfg = tier === 'hard' ? HARD : SOFT
  const q = opts.entryQuote ?? (tier === 'hard' ? quoteHardEntry(1) : quoteSoftEntry(1))
  const extra = Math.max(0, Math.min(25, Math.floor(opts.extraRaids)))
  const bank = opts.bank + extra * q.toBank
  const wins = opts.wins + extra
  const shares = opts.shares ?? 0
  const invested = opts.invested ?? cfg.createCost
  const ownerPayout =
    (tier === 'hard'
      ? settleHardClaimWithTax(bank, wins).ownerPayout
      : softClosePayout(bank, wins)) + shares
  const ownerRoi = invested > 0 ? ownerPayout / invested : 0
  const paid = Math.max(1e-9, q.cost)
  const raiderMult = (bank * cfg.clearRaiderFrac) / paid
  const canClaim = wins >= cfg.minWinsBeforeClaim
  return {
    extraRaids: extra,
    bank,
    wins,
    ownerPayout,
    ownerRoi,
    raiderMult,
    survival: survivalChance(cfg.targetClearP, extra),
    canClaim,
  }
}

export function softClosePayout(bank: number, _wins = 0): number {
  return bank * SOFT.clearOwnerFrac
}

export function hardClosePayout(bank: number, _wins = 0): number {
  return bank * HARD.clearOwnerFrac
}

export function hardRaiderClearPayout(bank: number): number {
  return bank * HARD.clearRaiderFrac
}

export function softRoi(payout: number, invested = SOFT.createCost): number {
  if (invested <= 0) return 0
  return payout / invested
}

export function hardRoi(payout: number, invested = HARD.createCost): number {
  if (invested <= 0) return 0
  return payout / invested
}

export function softSuggestedClose(
  bank: number,
  wins: number,
  closeRoi = SOFT.suggestedCloseRoi,
): boolean {
  if (wins < SOFT.minWinsBeforeClaim) return false
  return softRoi(softClosePayout(bank, wins)) >= closeRoi - 1e-9
}

export function hardSuggestedClose(
  bank: number,
  wins: number,
  closeRoi = HARD.suggestedCloseRoi,
): boolean {
  const { ownerPayout } = settleHardClaimWithTax(bank, wins)
  return hardRoi(ownerPayout) >= closeRoi - 1e-9
}

export function softMultDisplay(bank: number, paidEntry: number = SOFT.entryCost): string {
  const paid = Math.max(1e-9, paidEntry)
  return `${((bank * SOFT.clearRaiderFrac) / paid).toFixed(2)}×`
}

export function hardMultDisplay(bank: number, paidEntry: number = HARD.entryCost): string {
  const paid = Math.max(1e-9, paidEntry)
  return `${((bank * HARD.clearRaiderFrac) / paid).toFixed(2)}×`
}

export function softOwnerRoiDisplay(bank: number, wins: number): string {
  return `${softRoi(softClosePayout(bank, wins)).toFixed(2)}×`
}

export function hardOwnerRoiDisplay(bank: number, wins: number, shares: number): string {
  return `${hardRoi(hardClosePayout(bank, wins) + shares).toFixed(2)}×`
}

export function asSoftDungeon(bp: DungeonBlueprint, opts?: WrapOpts): DungeonBlueprint {
  return {
    ...bp,
    tier: 'soft',
    dungeonPowerScale: absoluteDungeonPowerScale('soft'),
    bank: bp.bank ?? SOFT.createToBank,
    wins: bp.wins ?? 0,
    status: bp.status ?? 'live',
    sharesAccrued: bp.sharesAccrued ?? 0,
    isOwned: opts?.owned ?? bp.isOwned,
    name: opts?.name ?? bp.name,
  }
}

export function asHardDungeon(bp: DungeonBlueprint, opts?: WrapOpts): DungeonBlueprint {
  return {
    ...bp,
    tier: 'hard',
    dungeonPowerScale: absoluteDungeonPowerScale('hard'),
    bank: bp.bank ?? HARD.createToBank,
    wins: bp.wins ?? 0,
    status: bp.status ?? 'live',
    sharesAccrued: bp.sharesAccrued ?? 0,
    isOwned: opts?.owned ?? bp.isOwned,
    name: opts?.name ?? bp.name,
  }
}

// ── Weekly pool distribution parameters ─────────────────────────────────────

/**
 * Fraction of weekly rewardPool earmarked for ticket payouts.
 * 25% balances win-25 jackpot (~30×) vs early-win modesty (~3.7× at win 7).
 * Calibrated in scripts/sim-hard-hold-curve.ts --search2.
 */
export const TICKET_POOL_FRAC = 0.25

/**
 * Fixed weekly pool burn fraction.
 * 0.5% creates mild deflationary pressure with negligible player impact.
 * At 200 Hard dungeons/week pool ≈ $5700 → burn ≈ $28.50/week.
 * Impact on raider×: −0.02×. Impact on owner ROI: −0.01×. Invisible in play.
 */
export const PROTOCOL_WEEKLY_BURN_FRAC = 0.005

// ── Ticket mint schedule (Hard only) ────────────────────────────────────────

/**
 * Fixed tickets minted when dungeon wins raid #`wins`.
 * Proportional to survival difficulty: rarer = more tickets per win.
 * wins 1–6: 0 · win 7: 1 · win 8: 2 · win 10: 3 · win 12: 4 · win 15: 8
 * win 18: 16 · win 20: 24 · win 25: 64
 */
export const TICKET_MINT_SCHEDULE: Readonly<Record<number, number>> = {
  7: 1, 8: 2, 9: 2, 10: 3, 11: 3, 12: 4, 13: 5, 14: 6,
  15: 8, 16: 10, 17: 13, 18: 16, 19: 20, 20: 24,
  21: 30, 22: 37, 23: 46, 24: 56,
}

/** Tickets minted at this specific win level (0 before win 7, 64 at win 25+). */
export function ticketMintAtWin(wins: number): number {
  if (wins <= 6) return 0
  if (wins >= 25) return 64
  return TICKET_MINT_SCHEDULE[wins] ?? 0
}

// ── Near-lock claim tax (replaces hard minWinsBeforeClaim) ───────────────────

/**
 * Fraction of bank burned as claim tax when owner closes Hard dungeon at `wins` victories.
 * Near-lock before win 7 (economic deterrent without hard block).
 *   win 1: 95% · win 2: 90% · win 3: 80% · win 4: 70% · win 5: 50%
 *   win 6: 20% · win 7: 5% · win 8+: 0%
 */
const CLAIM_TAX_CURVE = [0.95, 0.95, 0.90, 0.80, 0.70, 0.50, 0.20, 0.05, 0] as const
export function claimTaxFrac(wins: number): number {
  if (wins <= 0) return 0.95
  if (wins >= CLAIM_TAX_CURVE.length) return 0
  return CLAIM_TAX_CURVE[wins]!
}

/**
 * Hard claim with near-lock tax applied.
 * `taxed` → rewardPool · `fee` (5% of remainder) → rewardPool · `ownerPayout` → owner.
 */
export function settleHardClaimWithTax(
  bank: number,
  wins: number,
): { ownerPayout: number; fee: number; taxed: number } {
  const tax = claimTaxFrac(wins)
  const taxed = bank * tax
  const remaining = bank - taxed
  const fee = remaining * HARD.clearFeeFrac
  const ownerPayout = remaining * HARD.clearOwnerFrac
  return { ownerPayout, fee, taxed }
}

export function settleSoftCreate(
  wallet: WalletState,
): { wallet: WalletState; bank: number; invested: number } | null {
  const next = debit(wallet, SOFT.createCost)
  if (!next) return null
  return {
    wallet: applyProtocolFee(next, SOFT.createFee),
    bank: SOFT.createToBank,
    invested: SOFT.createCost,
  }
}

/** `createRerolls` = number of Hard create/dungeon offer rerolls (→ pool). */
export function settleHardCreate(
  wallet: WalletState,
  createRerolls = 0,
): { wallet: WalletState; bank: number; invested: number } | null {
  const reroll$ = rerollCostSum(createRerolls)
  const cost = HARD.createCost + reroll$
  let next = debit(wallet, cost)
  if (!next) return null
  next = applyProtocolFee(next, HARD.createFee)
  next = addToPool(next, reroll$)
  return {
    wallet: next,
    bank: HARD.createToBank,
    invested: cost,
  }
}

/**
 * Soft entry. Product keeps mul=1; `entryMul` kept for quote symmetry / future levers.
 */
export function settleSoftEntry(
  wallet: WalletState,
  entryMul = 1,
): { wallet: WalletState; bankAdd: number; quote: EntryQuote } | null {
  const quote = quoteSoftEntry(entryMul)
  let next = debit(wallet, quote.cost)
  if (!next) return null
  next = addToPool(next, quote.toPool)
  if (SOFT.entryToProtocol > 0) next = applyProtocolFee(next, SOFT.entryToProtocol)
  return { wallet: next, bankAdd: quote.toBank, quote }
}

/** Pay one Hard offer reroll (Friend or dungeon create). $ → rewardPool. */
export function payHardOfferReroll(
  wallet: WalletState,
  already: number,
): { wallet: WalletState; cost: number } | null {
  const cost = rerollCost(already)
  let next = debit(wallet, cost)
  if (!next) return null
  next = addToPool(next, cost)
  return { wallet: next, cost }
}

/**
 * Hard entry under optional market mul (raid-glut discount).
 * Friend offer rerolls are paid live via `payHardOfferReroll` (not bundled here).
 */
export function settleHardEntry(
  wallet: WalletState,
  friendRerolls = 0,
  entryMul = 1,
): { wallet: WalletState; bankAdd: number; quote: EntryQuote } | null {
  const quote = quoteHardEntry(entryMul)
  const reroll$ = rerollCostSum(friendRerolls)
  const cost = quote.cost + reroll$
  let next = debit(wallet, cost)
  if (!next) return null
  next = addToPool(next, quote.toPool + reroll$)
  if (HARD.entryToProtocol > 0) next = applyProtocolFee(next, HARD.entryToProtocol)
  return { wallet: next, bankAdd: quote.toBank, quote }
}

export function settleSoftClaim(
  bank: number,
  wins: number,
): { ownerPayout: number; fee: number } {
  return {
    ownerPayout: softClosePayout(bank, wins),
    fee: bank * SOFT.clearFeeFrac,
  }
}

export function settleHardClaim(
  bank: number,
  wins: number,
): { ownerPayout: number; fee: number } {
  return {
    ownerPayout: hardClosePayout(bank, wins),
    fee: bank * HARD.clearFeeFrac,
  }
}
