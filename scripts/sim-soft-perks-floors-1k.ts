/**
 * Soft ×1000 — floor deaths + perk performance (which help / which punish).
 *
 *   npx tsx scripts/sim-soft-perks-floors-1k.ts
 */
import { writeFileSync } from 'node:fs'
import { generateBlueprint } from '../src/game/mapGen.ts'
import { SOFT, SOFT_FLOOR_STAMINA, absoluteDungeonPowerScale } from '../src/game/economy.ts'
import {
  createEmptyPerksState,
  createEmptySideState,
  revealDungeonPick,
  rollFriendOffer,
  rollOffer,
  selectFriendPerk,
  selectPerk,
  syncRaidWithPerks,
  type DungeonPerkId,
  type FriendPerkId,
} from '../src/game/perks/index.ts'
import { advanceFloor, startRaid, tickRaid } from '../src/game/raid.ts'
import { mulberry32 } from '../src/game/rng.ts'
import type { DungeonBlueprint, RaidState } from '../src/game/types.ts'

const N = 1000
const FRIEND_IDS: FriendPerkId[] = [
  'dash',
  'fearless',
  'sharpEye',
  'endurance',
  'rally',
  'dodge',
]
const DUNGEON_IDS: DungeonPerkId[] = [
  'horde',
  'dreadfulBeasts',
  'fog',
  'walls',
  'thickHide',
  'sharpClaws',
]

const FV: Record<FriendPerkId, number> = {
  dash: 100,
  fearless: 92,
  sharpEye: 90,
  endurance: 85,
  rally: 84,
  dodge: 70,
}
const DV: Record<DungeonPerkId, number> = {
  horde: 100,
  dreadfulBeasts: 92,
  fog: 88,
  walls: 85,
  thickHide: 82,
  sharpClaws: 78,
}

function plan(rng: () => number) {
  let side = createEmptySideState<DungeonPerkId>()
  const picks: { id: DungeonPerkId; rank: 1 | 2 | 3 }[] = []
  for (let i = 0; i < 3; i++) {
    const o = rollOffer('dungeon', side.ranks, rng)
    if (!o) break
    const id = DV[o[0]!] >= DV[o[1]!] ? o[0]! : o[1]!
    side = selectPerk(side, id)
    const rank = side.ranks[id]
    if (rank) picks.push({ id, rank })
  }
  return { picks }
}

function play(r: RaidState): RaidState {
  let t = 0
  while (r.phase === 'running' && t++ < 600) r = tickRaid(r)
  return r.phase === 'running' ? { ...r, phase: 'dead' } : r
}

function pct(x: number) {
  return `${(100 * x).toFixed(1)}%`
}

function main() {
  const lines: string[] = []
  const log = (s = '') => {
    lines.push(s)
    console.log(s)
  }

  let die1 = 0,
    die2 = 0,
    die3 = 0,
    clear = 0

  /** Friend perk present at end of raid (or death) → clear? */
  const friendSeen: Record<string, number> = {}
  const friendClear: Record<string, number> = {}
  /** Dungeon perk was in planned loadout → Friend died on which floor / cleared */
  const dungSeen: Record<string, number> = {}
  const dungDie1: Record<string, number> = {}
  const dungDie2: Record<string, number> = {}
  const dungDie3: Record<string, number> = {}
  const dungClear: Record<string, number> = {}
  /** When death on floor f, which dungeon perk was just revealed that floor */
  const revealedOnDeathFloor: Record<string, number> = {}
  const revealedOnClearFloor: Record<string, number> = {}

  for (const id of FRIEND_IDS) {
    friendSeen[id] = 0
    friendClear[id] = 0
  }
  for (const id of DUNGEON_IDS) {
    dungSeen[id] = 0
    dungDie1[id] = 0
    dungDie2[id] = 0
    dungDie3[id] = 0
    dungClear[id] = 0
    revealedOnDeathFloor[id] = 0
    revealedOnClearFloor[id] = 0
  }

  log(`SOFT perk+floor ×${N}`)
  log(
    `STA Soft [${SOFT_FLOOR_STAMINA[1]}, ${SOFT_FLOOR_STAMINA[2]}, ${SOFT_FLOOR_STAMINA[3]}] · abs=${absoluteDungeonPowerScale('soft')} · efficacy×${SOFT.dungeonEfficacy} · fright−${SOFT.friendFrightCut}`,
  )
  log('Target: F1 pass almost all → fewer F2 → clear ~33% (Soft-only)\n')

  for (let i = 0; i < N; i++) {
    const seed = 0x50f70000 + i * 7919
    const perkRng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
    const bp: DungeonBlueprint = {
      ...generateBlueprint((seed * 1664525 + 1013904223) >>> 0, 's'),
      tier: 'soft',
      dungeonPowerScale: absoluteDungeonPowerScale('soft'),
    }
    const planned = plan(mulberry32((seed ^ 0xdeadbeef) >>> 0))
    for (const p of planned.picks) {
      dungSeen[p.id] = (dungSeen[p.id] ?? 0) + 1
    }

    let perks = createEmptyPerksState()
    let raid = startRaid(bp, 1)
    let outcome: 'die1' | 'die2' | 'die3' | 'clear' = 'die3'

    for (let floor = 1; floor <= 3; floor++) {
      const offer = rollFriendOffer(perks, perkRng)
      if (offer) {
        const id = FV[offer[0]!] >= FV[offer[1]!] ? offer[0]! : offer[1]!
        perks = selectFriendPerk(perks, id)
      }
      perks = { ...perks, dungeon: revealDungeonPick(perks.dungeon, planned, floor - 1) }
      const revealed = planned.picks[floor - 1]
      raid = syncRaidWithPerks(raid, perks)
      raid = play(raid)

      if (raid.phase === 'dead') {
        if (floor === 1) outcome = 'die1'
        else if (floor === 2) outcome = 'die2'
        else outcome = 'die3'
        if (revealed) revealedOnDeathFloor[revealed.id] = (revealedOnDeathFloor[revealed.id] ?? 0) + 1
        break
      }
      if (raid.phase === 'floorClear' || raid.phase === 'won') {
        if (revealed) revealedOnClearFloor[revealed.id] = (revealedOnClearFloor[revealed.id] ?? 0) + 1
        if (floor >= 3 || raid.phase === 'won') {
          outcome = 'clear'
          break
        }
        raid = advanceFloor(raid, bp)
        continue
      }
      if (floor === 1) outcome = 'die1'
      else if (floor === 2) outcome = 'die2'
      else outcome = 'die3'
      break
    }

    if (outcome === 'die1') die1++
    else if (outcome === 'die2') die2++
    else if (outcome === 'die3') die3++
    else clear++

    const cleared = outcome === 'clear'
    for (const id of FRIEND_IDS) {
      if ((perks.friend.ranks[id] ?? 0) > 0) {
        friendSeen[id]++
        if (cleared) friendClear[id]++
      }
    }
    for (const p of planned.picks) {
      if (outcome === 'die1') dungDie1[p.id]++
      else if (outcome === 'die2') dungDie2[p.id]++
      else if (outcome === 'die3') dungDie3[p.id]++
      else dungClear[p.id]++
    }
  }

  const reach2 = N - die1
  const reach3 = reach2 - die2
  log('══ Floor deaths ══')
  log(`  die F1 ${die1}  ${pct(die1 / N)}`)
  log(`  die F2 ${die2}  ${pct(die2 / N)}  cum ${pct((die1 + die2) / N)}  | cond ${pct(reach2 ? die2 / reach2 : 0)}`)
  log(`  die F3 ${die3}  ${pct(die3 / N)}  cum ${pct((die1 + die2 + die3) / N)}  | cond ${pct(reach3 ? die3 / reach3 : 0)}`)
  log(`  CLEAR  ${clear}  ${pct(clear / N)}`)
  log(
    `  shape F1<F2<F3 abs? ${die1 < die2 && die2 < die3 ? 'YES' : 'no'}  cond F2<F3? ${reach2 && reach3 && die2 / reach2 < die3 / reach3 ? 'YES' : 'no'}`,
  )

  log('\n══ Friend perks (pick → clear rate when owned) ══')
  const friendRows = FRIEND_IDS.map((id) => ({
    id,
    n: friendSeen[id]!,
    wr: friendSeen[id]! ? friendClear[id]! / friendSeen[id]! : 0,
  })).sort((a, b) => b.wr - a.wr)
  for (const r of friendRows) {
    log(`  ${r.id.padEnd(12)} n=${r.n}  clear|own ${pct(r.wr)}`)
  }

  log('\n══ Dungeon perks in loadout (→ outcome mix) ══')
  for (const id of DUNGEON_IDS) {
    const n = dungSeen[id]!
    if (!n) continue
    log(
      `  ${id.padEnd(16)} n=${n}  die1 ${pct(dungDie1[id]! / n)} die2 ${pct(dungDie2[id]! / n)} die3 ${pct(dungDie3[id]! / n)} clear ${pct(dungClear[id]! / n)}`,
    )
  }

  log('\n══ Dungeon perk revealed on this floor when Friend died / cleared that floor ══')
  for (const id of DUNGEON_IDS) {
    const d = revealedOnDeathFloor[id]!
    const c = revealedOnClearFloor[id]!
    const t = d + c
    if (!t) continue
    log(`  ${id.padEnd(16)} deathOnReveal ${d}  clearOnReveal ${c}  killRate ${pct(t ? d / t : 0)}`)
  }

  writeFileSync('soft-perks-floors-1k-out.txt', lines.join('\n'), 'utf8')
  log('\nWrote soft-perks-floors-1k-out.txt')
}

main()
