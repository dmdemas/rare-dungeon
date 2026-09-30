import type { Rng } from '../rng'
import { idsFor } from './catalog'
import type { PerkId, PerkOffer, PerkRank, PerkSide } from './types'

function pickUniform<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!
}

/**
 * Weighted random pick from items.
 * Each item's probability is proportional to its weight.
 */
function pickWeighted<T>(rng: Rng, items: readonly T[], weight: (item: T) => number): T {
  const total = items.reduce((sum, item) => sum + weight(item), 0)
  let r = rng() * total
  for (const item of items) {
    r -= weight(item)
    if (r <= 0) return item
  }
  return items[items.length - 1]!
}

/**
 * Each round: start from the side's full pool of 6 (lines already at III excluded).
 * Every remaining perk has equal weight (1/n among eligible; n=6 when none are maxed).
 * 1) pick one — uniformly, or weighted when dangerMap is true
 * 2) pick the second from the remaining (no duplicate id)
 * Friend and Dungeon use the same rule on their own pools.
 *
 * Corridor-safety (dangerMap = true):
 *   - 'horde'  offer weight ×0.50  (−50%)
 *   - 'walls'  offer weight ×0.65  (−35%)
 */
export function rollOffer<T extends PerkId>(
  side: PerkSide,
  ranks: Partial<Record<T, PerkRank>>,
  rng: Rng,
  dangerMap = false,
): PerkOffer<T> | null {
  const pool = idsFor(side).filter((id) => (ranks[id as T] ?? 0) < 3) as T[]
  if (pool.length < 2) return null

  if (!dangerMap) {
    const first = pickUniform(rng, pool)
    const rest = pool.filter((id) => id !== first)
    const second = pickUniform(rng, rest)
    return [first, second]
  }

  // Corridor-safety: weighted by danger multiplier
  const dangerWeight = (id: T): number => {
    if ((id as string) === 'horde') return 0.5
    if ((id as string) === 'walls') return 0.65
    return 1
  }

  const first = pickWeighted(rng, pool, dangerWeight)
  const rest = pool.filter((id) => id !== first)
  const second = pickWeighted(rng, rest, dangerWeight)
  return [first, second]
}
