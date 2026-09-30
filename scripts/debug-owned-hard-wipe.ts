/**
 * Why do player-created Hard dungeons get robbed so often?
 * Builds dungeons exactly like CreateDungeon.finishCreate and runs the "Simulate raids" raid.
 *
 *   npx tsx scripts/debug-owned-hard-wipe.ts
 */
import { asHardDungeon } from '../src/game/economy.ts'
import { rebuildWallSet, relocateOffPits } from '../src/game/mapGen.ts'
import {
  createEmptyPerksState,
  createEmptySideState,
  rollOffer,
  selectPerk,
  syncRaidWithPerks,
  type DungeonPerkId,
} from '../src/game/perks/index.ts'
import { pickCreatePair } from '../src/game/poolGen.ts'
import { startRaid } from '../src/game/raid.ts'
import { mulberry32 } from '../src/game/rng.ts'
import type { DungeonBlueprint } from '../src/game/types.ts'
import { runEconomyRaid } from '../src/game/worldSim.ts'

const LAYOUTS = 300
const RAIDS_PER = 20

function createLike(bp: DungeonBlueprint, rng: () => number, bake: boolean): DungeonBlueprint {
  if (!bake) return bp
  let side = createEmptySideState<DungeonPerkId>()
  let preview = startRaid(bp)
  for (let i = 0; i < 3; i++) {
    const o = rollOffer('dungeon', side.ranks, rng, bp.isCorridor ?? false)
    if (!o) break
    side = selectPerk(side, o[rng() < 0.5 ? 0 : 1]!)
    preview = syncRaidWithPerks(preview, { ...createEmptyPerksState(), dungeon: side })
  }
  const tiles = [...preview.map.tiles]
  return {
    ...bp,
    map: { tiles, walls: rebuildWallSet(tiles) },
    mobSpawns: relocateOffPits(
      tiles,
      preview.mobs.filter((m) => !m.fromHorde).map((m) => ({ x: m.x, y: m.y })),
      mulberry32(0x5150),
    ),
    perkPitKeys: [...preview.wallsPerkCells],
    dungeonPerks: { slots: side.slots, ranks: side.ranks as Record<string, 1 | 2 | 3> },
  }
}

function run(label: string, bake: boolean) {
  const rng = mulberry32(0xc0ffee)
  let raids = 0
  let wiped = 0
  const floors = [0, 0, 0, 0]
  for (let i = 0; i < LAYOUTS; i++) {
    const [a] = pickCreatePair('hard')
    const bp = createLike(asHardDungeon(a!, { owned: true }), rng, bake)
    for (let r = 0; r < RAIDS_PER; r++) {
      const step = runEconomyRaid(bp, rng)
      raids++
      if (step.wiped) wiped++
      else floors[step.floor]!++
    }
  }
  console.log(
    `${label}: robbed ${((wiped / raids) * 100).toFixed(1)}% of ${raids} raids · died F1 ${((floors[1]! / raids) * 100).toFixed(1)}% F2 ${((floors[2]! / raids) * 100).toFixed(1)}% F3 ${((floors[3]! / raids) * 100).toFixed(1)}%`,
  )
}

run('create layouts, no baked perks (rolled per raid)', false)
run('create layouts, baked like Create screen', true)
