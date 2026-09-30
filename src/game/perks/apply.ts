import { getPerkDef } from './catalog'
import type { PerkId, PerkRank, PerkSide } from './types'

/** Opaque context for later combat/map wiring. Layer 1: unused. */
export type ApplyContext = {
  side: PerkSide
}

export type ApplyResult = {
  ok: true
  stub: true
  id: PerkId
  rank: PerkRank
  name: string
  /** What full logic would touch — not executed yet. */
  wouldAffect: string
}

/**
 * Stub apply — records intent only. No combat, map, or stamina changes.
 */
export function apply(id: PerkId, rank: PerkRank, _ctx?: ApplyContext): ApplyResult {
  const def = getPerkDef(id)
  return {
    ok: true,
    stub: true,
    id,
    rank,
    name: def.name,
    wouldAffect: `${def.side}:${def.name} rank ${rank} (${def.ranks[rank - 1]})`,
  }
}
