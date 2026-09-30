import { generateBlueprint } from '../src/game/mapGen.ts'
import {
  createEmptyPerksState,
  createEmptySideState,
  selectFriendPerk,
  selectPerk,
  revealDungeonPick,
  syncRaidWithPerks,
  type FriendPerkId,
  type DungeonPerkId,
} from '../src/game/perks/index.ts'
import { startRaid, tickRaid, advanceFloor } from '../src/game/raid.ts'
import type { DungeonBlueprint } from '../src/game/types.ts'

function buildPlanned(perkId: DungeonPerkId | null) {
  if (!perkId) return { picks: [] as { id: DungeonPerkId; rank: 1|2|3 }[] }
  let side = createEmptySideState<DungeonPerkId>()
  const picks: { id: DungeonPerkId; rank: 1|2|3 }[] = []
  for (let slot = 0; slot < 3; slot++) {
    side = selectPerk(side, perkId)
    const rank = side.ranks[perkId]
    if (rank) picks.push({ id: perkId, rank })
  }
  return { picks }
}

const seeds = [0xf255fcb4, 0x3eeb7be1, 0x0a6c76ef]
const combos: Array<[string, FriendPerkId|null, DungeonPerkId|null]> = [
  ['dash',       'dash',       null],
  ['endurance',  'endurance',  null],
  ['fearless',   'fearless',   null],
  ['rally',      'rally',      null],
]

for (const seed of seeds) {
  const bp: DungeonBlueprint = {
    ...generateBlueprint(seed >>> 0, 'v'),
    tier: 'hard',
    dungeonPowerScale: 0.92,
  }
  const mobs  = bp.mobSpawns?.length ?? 0
  const walls = bp.map.tiles.filter((t: string) => t === 'wall').length
  console.log(`\nseed 0x${seed.toString(16)}  mobs=${mobs} walls=${walls}`)

  for (const [label, fp, dp] of combos) {
    const planned = buildPlanned(dp)
    let clears=0, die3=0
    const N = 200
    for (let i=0; i<N; i++) {
      let perks = createEmptyPerksState()
      let raid  = startRaid(bp, 1)
      let won   = false
      for (let floor=1; floor<=3 && !won; floor++) {
        if (floor>1) raid = advanceFloor(raid, bp)
        perks = { ...perks, dungeon: revealDungeonPick(perks.dungeon, planned, floor-1) }
        if (fp) perks = selectFriendPerk(perks, fp)
        raid = syncRaidWithPerks(raid, perks)
        let t=0
        while (raid.phase==='running' && t++<600) raid = tickRaid(raid)
        if (raid.phase==='won' || (raid.phase==='floorClear' && floor===3)) { clears++; won=true; break }
        if (raid.phase==='floorClear') continue
        if (floor===3) die3++
        break
      }
    }
    console.log(`  ${label.padEnd(12)} clears ${clears}/${N}  (${(clears*100/N).toFixed(0)}%)  dieF3=${die3}`)
  }
}
