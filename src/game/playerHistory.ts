import type { DungeonTier } from './economy'

type Base = { id: number; at: number; tier: DungeonTier; name: string }

/** Everything that happened to the player's own money, dungeons and raids. */
export type PlayerEvent =
  | (Base & { kind: 'created'; cost: number })
  | (Base & { kind: 'defended'; bankAdd: number; bankAfter: number; winsAfter: number; ticketsMinted: number })
  | (Base & { kind: 'robbed'; invested: number; wins: number; raiderTook: number; ticketsLost: number })
  | (Base & { kind: 'closed'; payout: number; invested: number; taxPct: number; wins: number; ticketsKept: number })
  | (Base & { kind: 'raidWon'; payout: number; paid: number; tickets: number })
  | (Base & { kind: 'raidLost'; paid: number; floor: number })
  | (Base & { kind: 'weekPaid'; week: number; payout: number; tickets: number })

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never
export type PlayerEventInput = DistributiveOmit<PlayerEvent, 'id' | 'at'>

let historyId = 0

export function playerEvent(input: PlayerEventInput, at: number = Date.now()): PlayerEvent {
  return { ...input, id: ++historyId, at } as PlayerEvent
}

/** Wallet cash flow of one event (entries and create costs negative). */
export function cashFlow(e: PlayerEvent): number {
  switch (e.kind) {
    case 'created':
      return -e.cost
    case 'closed':
      return e.payout
    case 'raidWon':
      return e.payout - e.paid
    case 'raidLost':
      return -e.paid
    case 'weekPaid':
      return e.payout
    case 'defended':
    case 'robbed':
      return 0
  }
}

export const isDungeonEvent = (e: PlayerEvent) =>
  e.kind === 'created' || e.kind === 'defended' || e.kind === 'robbed' || e.kind === 'closed'

export const isRaidEvent = (e: PlayerEvent) => e.kind === 'raidWon' || e.kind === 'raidLost'
