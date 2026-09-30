/**
 * Soft ×1000 dungeon lives — free claim + human owner mix.
 * Claim anytime (no minWins). Smart Friend combat.
 *
 *   npx tsx scripts/sim-soft-behavior.ts
 */
import { generateBlueprint } from '../src/game/mapGen.ts'
import { SOFT, absoluteDungeonPowerScale, softBankAfterKills, softClosePayout, softRoi } from '../src/game/economy.ts'
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

/** Human Soft owners — free claim, different appetite. */
type OwnerKind = 'chicken' | 'mid' | 'greedy' | 'holder'

const OWNERS: { kind: OwnerKind; w: number; label: string }[] = [
  { kind: 'chicken', w: 30, label: 'chicken — take a little (~1.0× / after 1 kill)' },
  { kind: 'mid', w: 40, label: 'mid — suggested ~1.5×' },
  { kind: 'greedy', w: 20, label: 'greedy — hold for ~2.0×' },
  { kind: 'holder', w: 10, label: 'holder — almost never claim (chase fat / shares fantasy)' },
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

function pickOwner(rng: () => number): OwnerKind {
  const t = OWNERS.reduce((s, x) => s + x.w, 0)
  let u = rng() * t
  for (const x of OWNERS) {
    u -= x.w
    if (u <= 0) return x.kind
  }
  return 'mid'
}

/** Target bank ROI to claim. holder = never (until cap). */
function closeRoi(kind: OwnerKind): number {
  if (kind === 'chicken') return 1.0
  if (kind === 'mid') return 1.5
  if (kind === 'greedy') return 2.0
  return 99
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

function raidClears(seed: number): boolean {
  const perkRng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const bp: DungeonBlueprint = {
    ...generateBlueprint((seed * 1664525 + 1013904223) >>> 0, 'v'),
    tier: 'soft',
    dungeonPowerScale: absoluteDungeonPowerScale('soft'),
  }
  const planned = plan(mulberry32((seed ^ 0xdeadbeef) >>> 0))
  let perks = createEmptyPerksState()
  let raid = startRaid(bp, 1)
  for (let floor = 1; floor <= 3; floor++) {
    const offer = rollFriendOffer(perks, perkRng)
    if (offer) {
      const id = FV[offer[0]!] >= FV[offer[1]!] ? offer[0]! : offer[1]!
      perks = selectFriendPerk(perks, id)
    }
    perks = { ...perks, dungeon: revealDungeonPick(perks.dungeon, planned, floor - 1) }
    raid = syncRaidWithPerks(raid, perks)
    raid = play(raid)
    if (raid.phase === 'dead') return false
    if (raid.phase === 'floorClear' || raid.phase === 'won') {
      if (floor >= 3 || raid.phase === 'won') return true
      raid = advanceFloor(raid, bp)
      continue
    }
    return false
  }
  return false
}

/** Free claim: owner may close whenever ROI target hit (any kills ≥ 0). */
function wantsClaim(kind: OwnerKind, bank: number, kills: number): boolean {
  const pay = softClosePayout(bank, kills)
  const roi = softRoi(pay)
  const target = closeRoi(kind)
  if (roi >= target - 1e-9) return true
  // chicken: also bail after first corpse even if slightly under 1.0×
  if (kind === 'chicken' && kills >= 1 && roi >= 0.95) return true
  return false
}

function pct(x: number) {
  return `${(100 * x).toFixed(1)}%`
}
function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

type Bucket = {
  n: number
  ownerWins: number
  raiderWins: number
  ownerPays: number[]
  raiderPays: number[]
  ownerRoi: number[]
  killsWhenClaim: number[]
  attempts: number
  attemptClears: number
}

function empty(): Bucket {
  return {
    n: 0,
    ownerWins: 0,
    raiderWins: 0,
    ownerPays: [],
    raiderPays: [],
    ownerRoi: [],
    killsWhenClaim: [],
    attempts: 0,
    attemptClears: 0,
  }
}

function main() {
  const rng = mulberry32(0xc0ffee01)
  console.log('SOFT ×', N, '— free claim + human owner mix')
  console.log('Create $' + SOFT.createCost, 'entry $' + SOFT.entryCost, '| claim anytime (minWins=0)')
  console.log('No pool shares in this run. Smart Friend.\n')
  console.log('Owner mix:')
  for (const o of OWNERS) console.log(`  ${o.w}%  ${o.label}`)
  console.log('')

  const byKind: Record<OwnerKind, Bucket> = {
    chicken: empty(),
    mid: empty(),
    greedy: empty(),
    holder: empty(),
  }
  const all = empty()

  for (let d = 0; d < N; d++) {
    const kind = pickOwner(rng)
    const b = byKind[kind]
    b.n++
    all.n++

    let kills = 0
    let done = false
    while (!done && kills < SOFT.maxLiveWins) {
      b.attempts++
      all.attempts++
      const cleared = raidClears(0x51f70000 + d * 10007 + kills * 7919)
      if (cleared) {
        b.attemptClears++
        all.attemptClears++
        const bank = softBankAfterKills(kills) + SOFT.entryToBank
        const pot = bank * SOFT.clearRaiderFrac
        b.raiderWins++
        all.raiderWins++
        b.raiderPays.push(pot)
        all.raiderPays.push(pot)
        done = true
        break
      }
      kills++
      const bank = softBankAfterKills(kills)
      if (wantsClaim(kind, bank, kills)) {
        const pay = softClosePayout(bank, kills)
        b.ownerWins++
        all.ownerWins++
        b.ownerPays.push(pay)
        all.ownerPays.push(pay)
        b.ownerRoi.push(pay / SOFT.createCost)
        all.ownerRoi.push(pay / SOFT.createCost)
        b.killsWhenClaim.push(kills)
        all.killsWhenClaim.push(kills)
        done = true
      }
    }
    if (!done) {
      // force close at cap — even holders
      const bank = softBankAfterKills(kills)
      const pay = softClosePayout(bank, kills)
      b.ownerWins++
      all.ownerWins++
      b.ownerPays.push(pay)
      all.ownerPays.push(pay)
      b.ownerRoi.push(pay / SOFT.createCost)
      all.ownerRoi.push(pay / SOFT.createCost)
      b.killsWhenClaim.push(kills)
      all.killsWhenClaim.push(kills)
    }
  }

  function report(title: string, b: Bucket) {
    const n = Math.max(1, b.n)
    const ownerEv = (mean(b.ownerPays) * b.ownerWins) / n - SOFT.createCost
    // crude: average $ received per life minus create (raider clears = $0 for owner)
    const ownerMeanPayAll = b.ownerPays.reduce((s, x) => s + x, 0) / n
    const ownerEv2 = ownerMeanPayAll - SOFT.createCost
    console.log(`══ ${title} (n=${b.n}) ══`)
    console.log(
      `  Raider takes dungeon  ${pct(b.raiderWins / n)}  |  Owner claims  ${pct(b.ownerWins / n)}`,
    )
    console.log(
      `  Friend clear / attempt  ${pct(b.attemptClears / Math.max(1, b.attempts))}  (${b.attemptClears}/${b.attempts})`,
    )
    console.log(
      `  When owner wins: mean $${mean(b.ownerPays).toFixed(2)}  (ROI ${mean(b.ownerRoi).toFixed(2)}×)  mean kills ${mean(b.killsWhenClaim).toFixed(1)}`,
    )
    console.log(
      `  When raider wins: mean pot $${mean(b.raiderPays).toFixed(2)}  (${(mean(b.raiderPays) / SOFT.entryCost).toFixed(2)}× entry)`,
    )
    console.log(`  Owner EV / life (bank only, no shares): $${ownerEv2.toFixed(2)}`)
    console.log('')
  }

  report('ALL humans mixed', all)
  for (const o of OWNERS) report(o.kind, byKind[o.kind])

  console.log('── read ──')
  console.log('Claim is free; mix only changes WHEN humans choose to take the bank.')
  console.log('Chickens reclaim more often / smaller $; holders get wiped more / fatter pots for raiders.')
  console.log('(Parity entry-discount levers are Hard-only WIP — see create-raid-parity rule.)')
}

main()
