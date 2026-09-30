/**
 * Runtime side of the pre-simulated world (scripts/gen-world-snapshots.ts):
 * starting 50+50 dungeons with real history, reserve refills, replayed feed.
 */
import { asHardDungeon, asSoftDungeon, type DungeonTier } from './economy'
import { generateBlueprint } from './mapGen'
import { generateDungeonPool } from './poolGen'
import type { DungeonBlueprint } from './types'
import { WORLD_SNAPSHOTS } from './worldSnapshots'
import { LIVE_PER_TIER, type FeedItem, type SnapDungeon, type WorldSnapshot } from './worldTypes'

export { WORLD_STEP_MS } from './worldTypes'
export type { FeedItem, WorldSnapshot } from './worldTypes'

export type GameEvent = {
  id: number
  message: string
  isJackpot: boolean
  isLoss: boolean
  item: FeedItem
  /** Wall-clock ms when the event happened (history items are back-dated). */
  at: number
  /** Pseudo wallet of the actor: raider on clear/fail, owner on claim/wiped. */
  who: string
}

export type Reserve = Record<DungeonTier, SnapDungeon[]>

export type World = {
  snapshot: WorldSnapshot
  pool: DungeonBlueprint[]
  reserve: Reserve
}

function toBlueprint(tier: DungeonTier, d: SnapDungeon): DungeonBlueprint {
  const raw = generateBlueprint(d.seed, d.name)
  const wrap = tier === 'hard' ? asHardDungeon : asSoftDungeon
  return wrap({
    ...raw,
    wins: d.wins,
    bank: d.bank,
    invested: d.invested,
    ticketPower: tier === 'hard' ? d.tickets : undefined,
  })
}

export function loadWorld(rng: () => number = Math.random): World {
  const snapshot = WORLD_SNAPSHOTS[Math.floor(rng() * WORLD_SNAPSHOTS.length)]!
  return {
    snapshot,
    pool: [
      ...snapshot.soft.slice(0, LIVE_PER_TIER).map((d) => toBlueprint('soft', d)),
      ...snapshot.hard.slice(0, LIVE_PER_TIER).map((d) => toBlueprint('hard', d)),
    ],
    reserve: {
      soft: snapshot.soft.slice(LIVE_PER_TIER),
      hard: snapshot.hard.slice(LIVE_PER_TIER),
    },
  }
}

/** Next reserve dungeon for `tier` (fresh approved dungeon once the reserve runs dry). */
export function takeFromReserve(reserve: Reserve, tier: DungeonTier): { bp: DungeonBlueprint; reserve: Reserve } {
  const [next, ...rest] = reserve[tier]
  if (next) return { bp: toBlueprint(tier, next), reserve: { ...reserve, [tier]: rest } }
  const seed = (Math.random() * 0x100000000) >>> 0
  const [bp] = generateDungeonPool(seed, tier === 'soft' ? 1 : 0, tier === 'hard' ? 1 : 0)
  return { bp: bp!, reserve }
}

// ── Feed text ────────────────────────────────────────────────────────────────

const money = (x: number) => `$${x >= 100 ? x.toFixed(0) : x.toFixed(2)}`
const tierLabel = (t: DungeonTier) => (t === 'hard' ? 'Hard' : 'Soft')
const JACKPOT_X: Record<DungeonTier, number> = { soft: 3, hard: 8 }

let feedId = 0

function fnv1a(s: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

function pseudoWallet(key: string): string {
  const hex =
    fnv1a(key, 0x811c9dc5).toString(16).padStart(8, '0') +
    fnv1a(key, 0x2545f491).toString(16).padStart(8, '0')
  return `0x${hex.slice(0, 3)}…${hex.slice(-3)}`
}

function actorKey(item: FeedItem): string {
  const n = item.kind === 'fail' ? item.floor : item.wins
  return `${item.kind === 'claim' || item.kind === 'wiped' ? 'owner' : 'raider'}|${item.tier}|${item.name}|${n}|${feedId}`
}

/** Headline multiplier of a positive event (raider × entry / owner × invested). */
export function eventMult(item: FeedItem): number | null {
  if (item.kind === 'clear') return item.payout / Math.max(1e-9, item.paid)
  if (item.kind === 'claim') return item.payout / Math.max(1e-9, item.invested)
  return null
}

export function feedEvent(item: FeedItem, at: number = Date.now()): GameEvent {
  const base = { item, at, who: pseudoWallet(actorKey(item)) }
  const id = ++feedId
  const where = `${tierLabel(item.tier)} '${item.name}'`
  switch (item.kind) {
    case 'clear': {
      const x = item.payout / item.paid
      return {
        ...base,
        id,
        message: `Friend earned ${x.toFixed(1)}× — ${money(item.payout)} (invested ${money(item.paid)}) · ${where}, ${item.wins} wins`,
        isJackpot: x >= JACKPOT_X[item.tier],
        isLoss: false,
      }
    }
    case 'claim': {
      const x = item.payout / item.invested
      return {
        ...base,
        id,
        message: `Owner claimed ${money(item.payout)} — ${x.toFixed(1)}× on ${money(item.invested)} · ${where}, ${item.wins} wins`,
        isJackpot: item.tier === 'hard' && x >= 4,
        isLoss: false,
      }
    }
    case 'fail':
      return {
        ...base,
        id,
        message: `Friend fell on floor ${item.floor} — −${money(item.lost)} · ${where}`,
        isJackpot: false,
        isLoss: true,
      }
    case 'wiped':
      return {
        ...base,
        id,
        message: `${where} was cleared at ${item.wins} wins — owner lost ${money(item.lost)}`,
        isJackpot: false,
        isLoss: true,
      }
  }
}
