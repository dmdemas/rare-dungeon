/**
 * Hard ×1000 — rerolls as in product:
 *   Dungeon create: 3 perk slots · offer each · can reroll many times ($1 then ×1.5, shared counter)
 *   Friend raid:    3 floors · offer each · same escalating price within the raid
 * All reroll $ → rewardPool. Also entry $1/raid → pool.
 *
 *   npx tsx scripts/sim-hard-reroll-pool.ts
 */
import {
  HARD,
  absoluteDungeonPowerScale,
  hardBankAfterKills,
  hardSuggestedClose,
  rerollCost,
  rerollCostSum,
} from '../src/game/economy.ts'
import {
  createEmptySideState,
  rollFriendOffer,
  rollOffer,
  selectFriendPerk,
  selectPerk,
  type DungeonPerkId,
  type FriendPerkId,
  type PerksState,
} from '../src/game/perks/index.ts'
import { createEmptyPerksState } from '../src/game/perks/state.ts'

const N = 1000

/** Dungeon perk “want” scores — hunt high lines when willing to pay. */
const DV: Record<DungeonPerkId, number> = {
  horde: 100,
  dreadfulBeasts: 92,
  fog: 88,
  walls: 85,
  thickHide: 82,
  sharpClaws: 78,
}
const FV: Record<FriendPerkId, number> = {
  dash: 100,
  fearless: 92,
  sharpEye: 90,
  endurance: 85,
  rally: 84,
  dodge: 70,
}

function mulberry32(a: number) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type OwnerKind = 'claimer' | 'holder' | 'whale'
type RaiderKind = 'bare' | 'perk1' | 'perkHunt' | 'yolo'

type Mix = {
  name: string
  owners: { kind: OwnerKind; w: number }[]
  raiders: { kind: RaiderKind; w: number }[]
}

function pick<T extends { w: number }>(rng: () => number, items: T[]): T {
  const t = items.reduce((s, x) => s + x.w, 0)
  let u = rng() * t
  for (const x of items) {
    u -= x.w
    if (u <= 0) return x
  }
  return items[items.length - 1]!
}

function pct(x: number) {
  return `${(100 * x).toFixed(1)}%`
}

function ownerCloseRoi(kind: OwnerKind): number {
  if (kind === 'holder') return 99
  if (kind === 'whale') return 2.5
  return 2.0
}

/** Max rerolls willing to burn on *this* offer (slot/floor), given style. */
function maxRerollsThisOffer(kind: OwnerKind | RaiderKind, offerIndex: number, rng: () => number): number {
  // offerIndex 0..2 = dungeon slot or Friend floor
  if (kind === 'bare') return 0
  if (kind === 'claimer') return offerIndex === 0 && rng() < 0.45 ? 1 : rng() < 0.15 ? 1 : 0
  if (kind === 'holder') return offerIndex < 2 ? 1 + (rng() < 0.35 ? 1 : 0) : rng() < 0.4 ? 1 : 0
  if (kind === 'whale') return 2 + Math.floor(rng() * 3) // 2–4 per slot
  if (kind === 'perk1') return 1 // one hunt attempt per floor max total style ≈ 1 preferred; allow 1/floor but often stop early
  if (kind === 'perkHunt') return 2 + Math.floor(rng() * 2) // 2–3 per floor hunting Dash
  // yolo
  return Math.floor(rng() * 4) // 0–3 this floor
}

function offerGoodEnoughDungeon(pair: [DungeonPerkId, DungeonPerkId], minScore: number): boolean {
  return DV[pair[0]] >= minScore || DV[pair[1]] >= minScore
}

function offerGoodEnoughFriend(pair: [FriendPerkId, FriendPerkId], kind: RaiderKind): boolean {
  if (kind === 'bare') return true
  if (kind === 'perkHunt') return pair[0] === 'dash' || pair[1] === 'dash'
  if (kind === 'perk1') return FV[pair[0]] >= 90 || FV[pair[1]] >= 90 // dash / fearless / sharpEye
  // yolo: accept if best ≥ 84 or random stop
  return FV[pair[0]] >= 84 || FV[pair[1]] >= 84
}

function dungeonMinScore(kind: OwnerKind): number {
  if (kind === 'whale') return 88 // horde / dread / fog
  if (kind === 'holder') return 85
  return 92 // claimer only bothers for top lines, else takes
}

/**
 * One offer cycle: roll → maybe reroll while not satisfied & under cap.
 * `already` = prior rerolls this session (create or raid) for price ladder.
 */
function resolveOffer<T extends string>(opts: {
  roll: () => [T, T] | null
  want: (o: [T, T]) => boolean
  maxRerolls: number
  already: { n: number; $: number }
  /** Always take best of final offer. */
  pickBest: (o: [T, T]) => T
}): { id: T | null; rerollsHere: number; $: number } {
  let o = opts.roll()
  if (!o) return { id: null, rerollsHere: 0, $: 0 }
  let here = 0
  while (here < opts.maxRerolls && !opts.want(o)) {
    opts.already.$ += rerollCost(opts.already.n)
    opts.already.n++
    here++
    const next = opts.roll()
    if (!next) break
    o = next
  }
  return { id: opts.pickBest(o), rerollsHere: here, $: 0 }
}

/** Clear p from Friend loadout quality (dash ranks help a lot). */
function clearPFromFriend(ranks: Partial<Record<FriendPerkId, number>>): number {
  const dash = ranks.dash ?? 0
  const base = 0.1
  // rough: dash I/II/III lifts toward ~25% cap (matches hard-targets dash hunt)
  const lift = dash === 0 ? 0 : dash === 1 ? 0.04 : dash === 2 ? 0.09 : 0.14
  const other =
    ((ranks.fearless ?? 0) + (ranks.sharpEye ?? 0) + (ranks.endurance ?? 0)) * 0.008
  return Math.min(0.25, base + lift + other)
}

function run(mix: Mix, seed: number) {
  const rng = mulberry32(seed)

  let lives = 0
  let attempts = 0
  let clears = 0

  let createPool$ = 0
  let friendPool$ = 0
  let entryPool$ = 0

  // Per slot / floor
  const dungRerollBySlot = [0, 0, 0]
  const dungAnyBySlot = [0, 0, 0]
  const friendRerollByFloor = [0, 0, 0]
  const friendAnyByFloor = [0, 0, 0]

  let createOffers = 0
  let friendOffers = 0
  let createMulti = 0 // offers with ≥2 rerolls
  let friendMulti = 0

  let totalCreateRerolls = 0
  let totalFriendRerolls = 0
  let livesWithAnyCreateReroll = 0
  let raidsWithAnyFriendReroll = 0

  for (let d = 0; d < N; d++) {
    lives++
    const ok = pick(rng, mix.owners).kind as OwnerKind

    // ── Create: 3 dungeon slots ──
    let side = createEmptySideState<DungeonPerkId>()
    const already = { n: 0, $: 0 }
    let lifeCreateRerolls = 0
    for (let slot = 0; slot < 3; slot++) {
      createOffers++
      const maxR = maxRerollsThisOffer(ok, slot, rng)
      const minScore = dungeonMinScore(ok)
      const res = resolveOffer({
        roll: () => rollOffer('dungeon', side.ranks, rng),
        want: (pair) =>
          ok === 'claimer' ? offerGoodEnoughDungeon(pair, minScore) || maxR === 0 : offerGoodEnoughDungeon(pair, minScore),
        maxRerolls: maxR,
        already,
        pickBest: (pair) => (DV[pair[0]] >= DV[pair[1]] ? pair[0] : pair[1]),
      })
      if (res.id) side = selectPerk(side, res.id)
      dungRerollBySlot[slot]! += res.rerollsHere
      if (res.rerollsHere > 0) dungAnyBySlot[slot]!++
      if (res.rerollsHere >= 2) createMulti++
      lifeCreateRerolls += res.rerollsHere
    }
    createPool$ += already.$
    totalCreateRerolls += lifeCreateRerolls
    if (lifeCreateRerolls > 0) livesWithAnyCreateReroll++

    // ── Raids until claim / wipe ──
    let kills = 0
    let done = false
    while (!done && kills < HARD.maxLiveWins) {
      attempts++
      const rk = pick(rng, mix.raiders).kind as RaiderKind
      let perks: PerksState = createEmptyPerksState()
      const frAlready = { n: 0, $: 0 }
      let raidFriendRerolls = 0

      for (let floor = 0; floor < 3; floor++) {
        friendOffers++
        const maxR = maxRerollsThisOffer(rk, floor, rng)
        // perk1: mostly one paid reroll total — after first spend, maxR→0 on later floors
        const effectiveMax =
          rk === 'perk1' && frAlready.n >= 1 ? 0 : rk === 'perk1' ? Math.min(1, maxR) : maxR

        const res = resolveOffer({
          roll: () => rollFriendOffer(perks, rng),
          want: (pair) => offerGoodEnoughFriend(pair, rk),
          maxRerolls: effectiveMax,
          already: frAlready,
          pickBest: (pair) => (FV[pair[0]] >= FV[pair[1]] ? pair[0] : pair[1]),
        })
        if (res.id) perks = selectFriendPerk(perks, res.id)
        friendRerollByFloor[floor]! += res.rerollsHere
        if (res.rerollsHere > 0) friendAnyByFloor[floor]!++
        if (res.rerollsHere >= 2) friendMulti++
        raidFriendRerolls += res.rerollsHere
      }

      friendPool$ += frAlready.$
      entryPool$ += HARD.entryToOwnerPool
      totalFriendRerolls += raidFriendRerolls
      if (raidFriendRerolls > 0) raidsWithAnyFriendReroll++

      const p = clearPFromFriend(perks.friend.ranks)
      if (rng() < p) {
        clears++
        done = true
        break
      }
      kills++
      const bank = hardBankAfterKills(kills)
      if (hardSuggestedClose(bank, kills, ownerCloseRoi(ok))) done = true
    }
  }

  const poolTotal = createPool$ + friendPool$ + entryPool$

  console.log(`\n══ ${mix.name} · N=${N} Hard lives ══`)
  console.log(`  Model: 3 dungeon slots + 3 Friend floors; multi-reroll/offer; $${HARD.rerollBase}→×${HARD.rerollGrowth} shared per session`)
  console.log(`  abs dungeon scale=${absoluteDungeonPowerScale('hard')}`)
  console.log(`  attempts ${attempts}  clear ${pct(clears / attempts)}  raids/life ${(attempts / lives).toFixed(2)}`)

  console.log('\n── How often (any reroll) ──')
  console.log(
    `  Dungeon create: ${pct(livesWithAnyCreateReroll / lives)} of lives · mean ${ (totalCreateRerolls / lives).toFixed(2)} rerolls/life · $${(createPool$ / lives).toFixed(2)}/life`,
  )
  console.log(
    `  Friend raid:    ${pct(raidsWithAnyFriendReroll / attempts)} of raids · mean ${(totalFriendRerolls / attempts).toFixed(2)} rerolls/raid · $${(friendPool$ / attempts).toFixed(2)}/raid`,
  )

  console.log('\n── Per dungeon slot (create) ──')
  for (let s = 0; s < 3; s++) {
    console.log(
      `  slot ${s + 1}: any-reroll ${pct(dungAnyBySlot[s]! / lives)}  mean rerolls ${(dungRerollBySlot[s]! / lives).toFixed(2)}`,
    )
  }
  console.log(`  offers with ≥2 rerolls: ${pct(createMulti / createOffers)} of dungeon offers`)

  console.log('\n── Per Friend floor (raid) ──')
  for (let f = 0; f < 3; f++) {
    console.log(
      `  floor ${f + 1}: any-reroll ${pct(friendAnyByFloor[f]! / attempts)}  mean rerolls ${(friendRerollByFloor[f]! / attempts).toFixed(2)}`,
    )
  }
  console.log(`  offers with ≥2 rerolls: ${pct(friendMulti / friendOffers)} of Friend offers`)

  console.log('\n── $ → rewardPool ──')
  console.log(`  dungeon create rerolls: $${createPool$.toFixed(0)}  (${pct(createPool$ / poolTotal)})`)
  console.log(`  Friend floor rerolls:   $${friendPool$.toFixed(0)}  (${pct(friendPool$ / poolTotal)})`)
  console.log(`  entry→pool $${HARD.entryToOwnerPool}/raid: $${entryPool$.toFixed(0)}  (${pct(entryPool$ / poolTotal)})`)
  console.log(`  TOTAL:                  $${poolTotal.toFixed(0)}`)
  console.log(`  per Hard life:          $${(poolTotal / lives).toFixed(2)}`)
  console.log(
    `  check sum(1..n): first 3 create mean $ = $${(rerollCostSum(Math.round(totalCreateRerolls / lives))).toFixed(2)} if packed`,
  )
}

function main() {
  console.log('HARD rerolls = 3 dungeon slots + 3 Friend floors, multi-reroll, escalating $ → pool')
  console.log(
    `Prices: create $${HARD.createCost} (bank $${HARD.createToBank}+fee $${HARD.createFee}) · entry $${HARD.entryCost} (bank $${HARD.entryToBank}+pool $${HARD.entryToOwnerPool})`,
  )
  console.log(
    `Reroll ladder (Friend=dungeon): $${HARD.rerollBase} → ×${HARD.rerollGrowth} → $${rerollCost(0)} / $${rerollCost(1)} / $${rerollCost(2).toFixed(2)} / $${rerollCost(3).toFixed(2)}…`,
  )
  console.log('Pool sources: (1) create rerolls (2) Friend rerolls (3) entry→pool slice. Create fee → burn/treasure, NOT pool.\n')
  console.log('P(see a given perk on 2-card) ≈ 33%; hunters keep spinning until hit / cap.\n')

  run(
    {
      name: 'BALANCED humans',
      owners: [
        { kind: 'claimer', w: 0.4 },
        { kind: 'holder', w: 0.35 },
        { kind: 'whale', w: 0.25 },
      ],
      raiders: [
        { kind: 'bare', w: 0.25 },
        { kind: 'perk1', w: 0.35 },
        { kind: 'perkHunt', w: 0.25 },
        { kind: 'yolo', w: 0.15 },
      ],
    },
    0x4e101001,
  )

  run(
    {
      name: 'REROLL-HEAVY',
      owners: [
        { kind: 'claimer', w: 0.2 },
        { kind: 'holder', w: 0.3 },
        { kind: 'whale', w: 0.5 },
      ],
      raiders: [
        { kind: 'bare', w: 0.1 },
        { kind: 'perk1', w: 0.2 },
        { kind: 'perkHunt', w: 0.45 },
        { kind: 'yolo', w: 0.25 },
      ],
    },
    0x4e102002,
  )

  run(
    {
      name: 'CHEAP',
      owners: [
        { kind: 'claimer', w: 0.7 },
        { kind: 'holder', w: 0.2 },
        { kind: 'whale', w: 0.1 },
      ],
      raiders: [
        { kind: 'bare', w: 0.55 },
        { kind: 'perk1', w: 0.3 },
        { kind: 'perkHunt', w: 0.1 },
        { kind: 'yolo', w: 0.05 },
      ],
    },
    0x4e103003,
  )

  console.log('\n══ Note ══')
  console.log(`  Create session & raid session each have their own $${HARD.rerollBase}→×${HARD.rerollGrowth} ladder.`)
  console.log('  Create fee → burn/treasure (not pool). Soft entry→pool not in this Hard-only run.')
  console.log('  Parity entry-discount = WIP (mul=1 here).')
}

main()
