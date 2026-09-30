/**
 * Pool inflow with ALL fees → rewardPool (burn OFF).
 * Soft create/entry fees + Hard create/entry/rerolls + clear 5% fees.
 *
 * Reports mean pool $ per 100 Soft raids and per 100 Hard raids (balanced humans).
 *
 *   npx tsx scripts/sim-pool-100.ts
 */
import {
  HARD,
  SOFT,
  PROTOCOL_BURN_ENABLED,
  hardBankAfterKills,
  hardClosePayout,
  hardRaiderClearPayout,
  hardSuggestedClose,
  rerollCost,
  softBankAfterKills,
  softClosePayout,
  softSuggestedClose,
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

type Bucket = {
  softCreateFee: number
  softEntryPool: number
  hardCreateFee: number
  hardEntryPool: number
  hardCreateReroll: number
  hardFriendReroll: number
  softClearFee: number
  hardClearFee: number
}

function empty(): Bucket {
  return {
    softCreateFee: 0,
    softEntryPool: 0,
    hardCreateFee: 0,
    hardEntryPool: 0,
    hardCreateReroll: 0,
    hardFriendReroll: 0,
    softClearFee: 0,
    hardClearFee: 0,
  }
}

function total(b: Bucket) {
  return (
    b.softCreateFee +
    b.softEntryPool +
    b.hardCreateFee +
    b.hardEntryPool +
    b.hardCreateReroll +
    b.hardFriendReroll +
    b.softClearFee +
    b.hardClearFee
  )
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

function maxR(kind: OwnerKind | RaiderKind, i: number, rng: () => number): number {
  if (kind === 'bare') return 0
  if (kind === 'claimer') return i === 0 && rng() < 0.45 ? 1 : rng() < 0.15 ? 1 : 0
  if (kind === 'holder') return i < 2 ? 1 + (rng() < 0.35 ? 1 : 0) : rng() < 0.4 ? 1 : 0
  if (kind === 'whale') return 2 + Math.floor(rng() * 3)
  if (kind === 'perk1') return 1
  if (kind === 'perkHunt') return 2 + Math.floor(rng() * 2)
  return Math.floor(rng() * 4)
}

function resolveOffer<T extends string>(opts: {
  roll: () => [T, T] | null
  want: (o: [T, T]) => boolean
  maxRerolls: number
  already: { n: number; $: number }
  pickBest: (o: [T, T]) => T
}): T | null {
  let o = opts.roll()
  if (!o) return null
  let here = 0
  while (here < opts.maxRerolls && !opts.want(o)) {
    opts.already.$ += rerollCost(opts.already.n)
    opts.already.n++
    here++
    const next = opts.roll()
    if (!next) break
    o = next
  }
  return opts.pickBest(o)
}

function clearP(ranks: Partial<Record<FriendPerkId, number>>, soft: boolean): number {
  if (soft) return SOFT.targetClearP
  const dash = ranks.dash ?? 0
  const lift = dash === 0 ? 0 : dash === 1 ? 0.04 : dash === 2 ? 0.09 : 0.14
  const other =
    ((ranks.fearless ?? 0) + (ranks.sharpEye ?? 0) + (ranks.endurance ?? 0)) * 0.008
  return Math.min(0.25, 0.1 + lift + other)
}

function friendRaid(rk: RaiderKind, rng: () => number, soft: boolean) {
  let perks: PerksState = createEmptyPerksState()
  const already = { n: 0, $: 0 }
  if (!soft) {
    for (let floor = 0; floor < 3; floor++) {
      const cap = rk === 'perk1' && already.n >= 1 ? 0 : rk === 'perk1' ? 1 : maxR(rk, floor, rng)
      const id = resolveOffer({
        roll: () => rollFriendOffer(perks, rng),
        want: (pair) => {
          if (rk === 'bare') return true
          if (rk === 'perkHunt') return pair[0] === 'dash' || pair[1] === 'dash'
          if (rk === 'perk1') return FV[pair[0]] >= 90 || FV[pair[1]] >= 90
          return FV[pair[0]] >= 84 || FV[pair[1]] >= 84
        },
        maxRerolls: cap,
        already,
        pickBest: (pair) => (FV[pair[0]] >= FV[pair[1]] ? pair[0] : pair[1]),
      })
      if (id) perks = selectFriendPerk(perks, id)
    }
  }
  return { reroll$: already.$, p: clearP(perks.friend.ranks, soft) }
}

function createHard(ok: OwnerKind, rng: () => number) {
  let side = createEmptySideState<DungeonPerkId>()
  const already = { n: 0, $: 0 }
  const min = ok === 'whale' ? 88 : ok === 'holder' ? 85 : 92
  for (let slot = 0; slot < 3; slot++) {
    const id = resolveOffer({
      roll: () => rollOffer('dungeon', side.ranks, rng),
      want: (pair) => DV[pair[0]] >= min || DV[pair[1]] >= min,
      maxRerolls: maxR(ok, slot, rng),
      already,
      pickBest: (pair) => (DV[pair[0]] >= DV[pair[1]] ? pair[0] : pair[1]),
    })
    if (id) side = selectPerk(side, id)
  }
  return already.$
}

function ownerRoi(kind: OwnerKind) {
  if (kind === 'holder') return 99
  if (kind === 'whale') return 2.5
  return 2.0
}

/** Run until `targetRaids` attempts for one tier; creates happen as dungeons die. */
function runTier(
  tier: 'soft' | 'hard',
  targetRaids: number,
  seed: number,
): { bucket: Bucket; raids: number; creates: number } {
  const rng = mulberry32(seed)
  const owners =
    tier === 'hard'
      ? [
          { kind: 'claimer' as const, w: 0.4 },
          { kind: 'holder' as const, w: 0.35 },
          { kind: 'whale' as const, w: 0.25 },
        ]
      : [{ kind: 'claimer' as const, w: 1 }]
  const raiders = [
    { kind: 'bare' as const, w: 0.25 },
    { kind: 'perk1' as const, w: 0.35 },
    { kind: 'perkHunt' as const, w: 0.25 },
    { kind: 'yolo' as const, w: 0.15 },
  ]
  const b = empty()
  let raids = 0
  let creates = 0

  while (raids < targetRaids) {
    const ok = pick(rng, owners).kind
    creates++
    if (tier === 'soft') {
      b.softCreateFee += SOFT.createFee
    } else {
      b.hardCreateFee += HARD.createFee
      b.hardCreateReroll += createHard(ok, rng)
    }

    let kills = 0
    let live = true
    const maxW = tier === 'soft' ? SOFT.maxLiveWins : HARD.maxLiveWins
    while (live && raids < targetRaids && kills < maxW) {
      raids++
      const rk = pick(rng, raiders).kind
      const fr = friendRaid(rk, rng, tier === 'soft')
      if (tier === 'soft') {
        b.softEntryPool += SOFT.entryToOwnerPool
      } else {
        b.hardEntryPool += HARD.entryToOwnerPool
        b.hardFriendReroll += fr.reroll$
      }

      const bankNow =
        tier === 'soft'
          ? softBankAfterKills(kills) + SOFT.entryToBank
          : hardBankAfterKills(kills) + HARD.entryToBank

      if (rng() < fr.p) {
        // Friend clear — 5% fee → pool
        const fee =
          bankNow * (tier === 'soft' ? SOFT.clearFeeFrac : HARD.clearFeeFrac)
        if (tier === 'soft') b.softClearFee += fee
        else b.hardClearFee += fee
        live = false
        break
      }
      kills++
      const bank = tier === 'soft' ? softBankAfterKills(kills) : hardBankAfterKills(kills)
      const close =
        tier === 'soft'
          ? softSuggestedClose(bank, kills, SOFT.suggestedCloseRoi)
          : hardSuggestedClose(bank, kills, ownerRoi(ok))
      if (close) {
        const fee =
          bank * (tier === 'soft' ? SOFT.clearFeeFrac : HARD.clearFeeFrac)
        if (tier === 'soft') b.softClearFee += fee
        else b.hardClearFee += fee
        live = false
      }
    }
  }
  return { bucket: b, raids, creates }
}

function printBucket(title: string, b: Bucket, raids: number, creates: number) {
  const t = total(b)
  console.log(`\n══ ${title} ══`)
  console.log(`  raids ${raids} · creates ${creates}`)
  console.log(`  Soft create fee          $${b.softCreateFee.toFixed(2)}`)
  console.log(`  Soft entry→pool          $${b.softEntryPool.toFixed(2)}`)
  console.log(`  Soft clear 5% fee        $${b.softClearFee.toFixed(2)}`)
  console.log(`  Hard create fee          $${b.hardCreateFee.toFixed(2)}`)
  console.log(`  Hard entry→pool          $${b.hardEntryPool.toFixed(2)}`)
  console.log(`  Hard create rerolls      $${b.hardCreateReroll.toFixed(2)}`)
  console.log(`  Hard Friend rerolls      $${b.hardFriendReroll.toFixed(2)}`)
  console.log(`  Hard clear 5% fee        $${b.hardClearFee.toFixed(2)}`)
  console.log(`  TOTAL pool               $${t.toFixed(2)}`)
  console.log(`  per 100 raids            $${((t / raids) * 100).toFixed(2)}`)
}

function main() {
  console.log('Reward pool inflow — ALL fees → pool, burn', PROTOCOL_BURN_ENABLED ? 'ON' : 'OFF')
  console.log(
    `Soft create$${SOFT.createCost}/fee$${SOFT.createFee} entry$${SOFT.entryCost}/pool$${SOFT.entryToOwnerPool}`,
  )
  console.log(
    `Hard create$${HARD.createCost}/fee$${HARD.createFee} entry$${HARD.entryCost}/pool$${HARD.entryToOwnerPool} reroll$${HARD.rerollBase}×${HARD.rerollGrowth}`,
  )

  // Many repeats of 100-raid windows → mean
  const WINDOWS = 50
  const softTotals: number[] = []
  const hardTotals: number[] = []
  let softSum = empty()
  let hardSum = empty()

  for (let w = 0; w < WINDOWS; w++) {
    const s = runTier('soft', 100, 0x50010000 + w * 9973)
    const h = runTier('hard', 100, 0x50020000 + w * 9973)
    softTotals.push(total(s.bucket))
    hardTotals.push(total(h.bucket))
    for (const k of Object.keys(softSum) as (keyof Bucket)[]) {
      softSum[k] += s.bucket[k]
      hardSum[k] += h.bucket[k]
    }
  }

  const scale = 1 / WINDOWS
  for (const k of Object.keys(softSum) as (keyof Bucket)[]) {
    softSum[k] *= scale
    hardSum[k] *= scale
  }

  printBucket('SOFT — mean per 100 raids (50 windows)', softSum, 100, softSum.softCreateFee / SOFT.createFee)
  printBucket('HARD — mean per 100 raids (50 windows)', hardSum, 100, hardSum.hardCreateFee / HARD.createFee)

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  console.log('\n══ Summary ══')
  console.log(`  Soft pool / 100 raids:  mean $${mean(softTotals).toFixed(2)}`)
  console.log(`  Hard pool / 100 raids:  mean $${mean(hardTotals).toFixed(2)}`)
  console.log(
    `  If mix 50 Soft + 50 Hard raids: ~$${(mean(softTotals) / 2 + mean(hardTotals) / 2).toFixed(2)}`,
  )
  console.log('\n  Anti early-claim: fat pool → holders earn shares; claimers cut themselves off.')
  console.log('  Burn/treasure OFF (PROTOCOL_BURN_ENABLED=false). Clear 5% also → pool.')
}

main()
