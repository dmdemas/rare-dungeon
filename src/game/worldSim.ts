/**
 * AI owner / raider behaviour + one raid settled with real economy rules.
 * Shared by scripts/gen-world-snapshots.ts (offline world history) and the
 * "simulate raids" button on player-owned dungeons.
 */
import {
  HARD,
  SOFT,
  TICKET,
  quoteHardEntry,
  quoteSoftEntry,
  rerollCostSum,
  settleHardClaimWithTax,
  settleSoftClaim,
  ticketMintAtWin,
  type DungeonTier,
} from './economy'
import { dungeonLoadoutFor, simulateRaid } from './headlessRaid'
import type { Rng } from './rng'
import type { DungeonBlueprint } from './types'

export type OwnerKind = 'claimer' | 'holder' | 'whale'
export type RaiderKind = 'bare' | 'perk1' | 'perkHunt' | 'yolo'

const OWNER_MIX: { kind: OwnerKind; w: number }[] = [
  { kind: 'claimer', w: 50 },
  { kind: 'holder', w: 35 },
  { kind: 'whale', w: 15 },
]

const RAIDER_MIX: { kind: RaiderKind; w: number }[] = [
  { kind: 'bare', w: 40 },
  { kind: 'perk1', w: 35 },
  { kind: 'perkHunt', w: 20 },
  { kind: 'yolo', w: 5 },
]

function pickWeighted<T extends { w: number }>(rng: Rng, items: T[]): T {
  const total = items.reduce((s, x) => s + x.w, 0)
  let u = rng() * total
  for (const x of items) {
    u -= x.w
    if (u <= 0) return x
  }
  return items[items.length - 1]!
}

export const rollOwnerKind = (rng: Rng): OwnerKind => pickWeighted(rng, OWNER_MIX).kind
export const rollRaiderKind = (rng: Rng): RaiderKind => pickWeighted(rng, RAIDER_MIX).kind

/** Hard create-offer rerolls bought by an AI owner. Soft has no rerolls. */
export function ownerCreateRerolls(tier: DungeonTier, kind: OwnerKind, rng: Rng): number {
  if (tier !== 'hard') return 0
  if (kind === 'whale') return 2 + Math.floor(rng() * 3)
  if (kind === 'holder') return 1 + Math.floor(rng() * 2)
  return Math.floor(rng() * 2)
}

/** Hard Friend-offer reroll budget of an AI raider for one raid (spent only on weak offers). */
export function raiderRerolls(tier: DungeonTier, kind: RaiderKind, rng: Rng): number {
  if (tier !== 'hard') return 0
  if (kind === 'bare') return 0
  if (kind === 'perk1') return 1
  if (kind === 'perkHunt') return 1 + Math.floor(rng() * 3)
  return Math.floor(rng() * 4)
}

/** AI owner exit rule, checked after each raid the dungeon survives. */
export function ownerWantsClaim(
  tier: DungeonTier,
  kind: OwnerKind,
  bank: number,
  wins: number,
  invested: number,
): boolean {
  if (tier === 'soft') {
    const roi = settleSoftClaim(bank, wins).ownerPayout / invested
    const target = kind === 'claimer' ? SOFT.suggestedCloseRoi : kind === 'holder' ? 2 : 2.5
    return roi >= target
  }
  if (kind === 'claimer') {
    return settleHardClaimWithTax(bank, wins).ownerPayout / invested >= HARD.suggestedCloseRoi
  }
  const raiderX = (bank * HARD.clearRaiderFrac) / HARD.entryCost
  if (kind === 'holder') return raiderX >= TICKET.holderExitRaiderX || wins >= TICKET.holderExitWins
  return wins >= TICKET.holderExitWins
}

export type RaidStep = {
  raider: RaiderKind
  /** Raider cleared all floors → dungeon wiped. */
  wiped: boolean
  floor: number
  /** Entry + Friend rerolls the raider actually used. */
  raiderPaid: number
  bankAfter: number
  winsAfter: number
  /** Raider payout (95% of bank) when wiped, else 0. */
  payout: number
  /** $ into rewardPool: entry pool share + rerolls (+ 5% clear fee on wipe). */
  poolAdd: number
  /** Tickets minted to the dungeon on a survive (Hard). */
  ticketsMinted: number
  /** Friend perks chosen per floor — used to replay the raid visually with identical outcome. */
  friendPickSequence: import('./headlessRaid').HeadlessRaidResult['friendPickSequence']
}

/** Dungeon state after `step`. A wipe closes it: bank goes to the raider, tickets leave. */
export function applyRaidStep(bp: DungeonBlueprint, step: RaidStep): DungeonBlueprint {
  if (step.wiped) {
    return {
      ...bp,
      status: 'closed',
      wiped: true,
      bank: 0,
      rewardPending: 0,
      sharesAccrued: 0,
      ticketPower: 0,
    }
  }
  return {
    ...bp,
    bank: step.bankAfter,
    wins: step.winsAfter,
    rewardPending: step.bankAfter,
    ticketPower: (bp.ticketPower ?? 0) + step.ticketsMinted,
  }
}

/** One AI raid on `bp` with real combat, settled by tier economy (entry at parity). */
export function runEconomyRaid(bp: DungeonBlueprint, rng: Rng): RaidStep {
  const tier = bp.tier ?? 'soft'
  const cfg = tier === 'hard' ? HARD : SOFT
  const quote = tier === 'hard' ? quoteHardEntry(1) : quoteSoftEntry(1)
  const raider = rollRaiderKind(rng)
  const rerollBudget = raiderRerolls(tier, raider, rng)
  const bank = (bp.bank ?? cfg.createToBank) + quote.toBank
  const wins = bp.wins ?? 0
  const result = simulateRaid(bp, dungeonLoadoutFor(bp, rng), rng, rerollBudget)
  const rerolls$ = rerollCostSum(result.rerollsUsed)

  if (result.won) {
    return {
      raider,
      wiped: true,
      floor: result.floor,
      raiderPaid: quote.cost + rerolls$,
      bankAfter: bank,
      winsAfter: wins,
      payout: bank * cfg.clearRaiderFrac,
      poolAdd: quote.toPool + rerolls$ + bank * cfg.clearFeeFrac,
      ticketsMinted: 0,
      friendPickSequence: result.friendPickSequence,
    }
  }
  return {
    raider,
    wiped: false,
    floor: result.floor,
    raiderPaid: quote.cost + rerolls$,
    bankAfter: bank,
    winsAfter: wins + 1,
    payout: 0,
    poolAdd: quote.toPool + rerolls$,
    ticketsMinted: tier === 'hard' ? ticketMintAtWin(wins + 1) : 0,
    friendPickSequence: result.friendPickSequence,
  }
}
