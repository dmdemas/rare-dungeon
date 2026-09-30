/**
 * Hard ×1000 — mean spend-to-earn for Friend vs dungeon owner.
 * create $30 / entry $15 / reroll $2.5×1.5
 *
 * Friend: one player grinds attempts across live Hard dungeons until first personal wipe.
 * Owner: 1000 dungeon lives → claim or wiped.
 *
 *   npx tsx scripts/sim-hard-spend-1k.ts
 */
import {
  HARD,
  absoluteDungeonPowerScale,
  hardBankAfterKills,
  hardClosePayout,
  hardRaiderClearPayout,
  hardRoi,
  hardSuggestedClose,
  rerollCost,
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
function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}
function quantile(xs: number[], q: number) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!
}

function ownerCloseRoi(kind: OwnerKind): number {
  if (kind === 'holder') return 99
  if (kind === 'whale') return 2.5
  return 2.0
}

function maxRerollsThisOffer(kind: OwnerKind | RaiderKind, offerIndex: number, rng: () => number): number {
  if (kind === 'bare') return 0
  if (kind === 'claimer') return offerIndex === 0 && rng() < 0.45 ? 1 : rng() < 0.15 ? 1 : 0
  if (kind === 'holder') return offerIndex < 2 ? 1 + (rng() < 0.35 ? 1 : 0) : rng() < 0.4 ? 1 : 0
  if (kind === 'whale') return 2 + Math.floor(rng() * 3)
  if (kind === 'perk1') return 1
  if (kind === 'perkHunt') return 2 + Math.floor(rng() * 2)
  return Math.floor(rng() * 4)
}

function dungeonMinScore(kind: OwnerKind): number {
  if (kind === 'whale') return 88
  if (kind === 'holder') return 85
  return 92
}

function resolveOffer<T extends string>(opts: {
  roll: () => [T, T] | null
  want: (o: [T, T]) => boolean
  maxRerolls: number
  already: { n: number; $: number }
  pickBest: (o: [T, T]) => T
}): { id: T | null } {
  let o = opts.roll()
  if (!o) return { id: null }
  let here = 0
  while (here < opts.maxRerolls && !opts.want(o)) {
    opts.already.$ += rerollCost(opts.already.n)
    opts.already.n++
    here++
    const next = opts.roll()
    if (!next) break
    o = next
  }
  return { id: opts.pickBest(o) }
}

function clearPFromFriend(ranks: Partial<Record<FriendPerkId, number>>): number {
  const dash = ranks.dash ?? 0
  const lift = dash === 0 ? 0 : dash === 1 ? 0.04 : dash === 2 ? 0.09 : 0.14
  const other =
    ((ranks.fearless ?? 0) + (ranks.sharpEye ?? 0) + (ranks.endurance ?? 0)) * 0.008
  return Math.min(0.25, 0.1 + lift + other)
}

function planDungeon(ok: OwnerKind, rng: () => number): { invest: number } {
  let side = createEmptySideState<DungeonPerkId>()
  const already = { n: 0, $: 0 }
  const minScore = dungeonMinScore(ok)
  for (let slot = 0; slot < 3; slot++) {
    const maxR = maxRerollsThisOffer(ok, slot, rng)
    const res = resolveOffer({
      roll: () => rollOffer('dungeon', side.ranks, rng),
      want: (pair) => DV[pair[0]] >= minScore || DV[pair[1]] >= minScore,
      maxRerolls: maxR,
      already,
      pickBest: (pair) => (DV[pair[0]] >= DV[pair[1]] ? pair[0] : pair[1]),
    })
    if (res.id) side = selectPerk(side, res.id)
  }
  return { invest: HARD.createCost + already.$ }
}

function oneFriendRaid(rk: RaiderKind, rng: () => number): { spend: number; clearP: number } {
  let perks: PerksState = createEmptyPerksState()
  const already = { n: 0, $: 0 }
  for (let floor = 0; floor < 3; floor++) {
    const maxR = maxRerollsThisOffer(rk, floor, rng)
    const effectiveMax = rk === 'perk1' && already.n >= 1 ? 0 : rk === 'perk1' ? Math.min(1, maxR) : maxR
    const res = resolveOffer({
      roll: () => rollFriendOffer(perks, rng),
      want: (pair) => {
        if (rk === 'bare') return true
        if (rk === 'perkHunt') return pair[0] === 'dash' || pair[1] === 'dash'
        if (rk === 'perk1') return FV[pair[0]] >= 90 || FV[pair[1]] >= 90
        return FV[pair[0]] >= 84 || FV[pair[1]] >= 84
      },
      maxRerolls: effectiveMax,
      already,
      pickBest: (pair) => (FV[pair[0]] >= FV[pair[1]] ? pair[0] : pair[1]),
    })
    if (res.id) perks = selectFriendPerk(perks, res.id)
  }
  return { spend: HARD.entryCost + already.$, clearP: clearPFromFriend(perks.friend.ranks) }
}

function main() {
  const rng = mulberry32(0x1530d015)
  const owners = [
    { kind: 'claimer' as const, w: 0.4 },
    { kind: 'holder' as const, w: 0.35 },
    { kind: 'whale' as const, w: 0.25 },
  ]
  const raiders = [
    { kind: 'bare' as const, w: 0.25 },
    { kind: 'perk1' as const, w: 0.35 },
    { kind: 'perkHunt' as const, w: 0.25 },
    { kind: 'yolo' as const, w: 0.15 },
  ]

  console.log('HARD spend-to-earn ×', N)
  console.log(
    `create $${HARD.createCost} (bank $${HARD.createToBank}+fee $${HARD.createFee}) · entry $${HARD.entryCost} (bank $${HARD.entryToBank}+pool $${HARD.entryToOwnerPool})`,
  )
  console.log(
    `reroll $${HARD.rerollBase}→×${HARD.rerollGrowth} · scale abs ${absoluteDungeonPowerScale('hard')} · minWins ${HARD.minWinsBeforeClaim}\n`,
  )

  // ── Owners: 1000 dungeon lives ──
  const ownerInvestClaim: number[] = []
  const ownerPayClaim: number[] = []
  const ownerNetClaim: number[] = []
  const ownerRoiClaim: number[] = []
  const ownerKillsClaim: number[] = []
  const ownerInvestWiped: number[] = []
  let ownerAttempts = 0
  let ownerClears = 0

  for (let d = 0; d < N; d++) {
    const ok = pick(rng, owners).kind
    const { invest } = planDungeon(ok, rng)
    let kills = 0
    let done = false
    while (!done && kills < HARD.maxLiveWins) {
      ownerAttempts++
      const rk = pick(rng, raiders).kind
      const raid = oneFriendRaid(rk, rng)
      const bankNow = hardBankAfterKills(kills) + HARD.entryToBank
      if (rng() < raid.clearP) {
        ownerClears++
        ownerInvestWiped.push(invest)
        done = true
        break
      }
      kills++
      const bank = hardBankAfterKills(kills)
      if (hardSuggestedClose(bank, kills, ownerCloseRoi(ok))) {
        const pay = hardClosePayout(bank, kills)
        ownerInvestClaim.push(invest)
        ownerPayClaim.push(pay)
        ownerNetClaim.push(pay - invest)
        ownerRoiClaim.push(hardRoi(pay, invest))
        ownerKillsClaim.push(kills)
        done = true
      }
    }
    if (!done) {
      const bank = hardBankAfterKills(kills)
      const pay = hardClosePayout(bank, kills)
      ownerInvestClaim.push(invest)
      ownerPayClaim.push(pay)
      ownerNetClaim.push(pay - invest)
      ownerRoiClaim.push(hardRoi(pay, invest))
      ownerKillsClaim.push(kills)
    }
  }

  // ── Friends: 1000 players each grind until first personal wipe ──
  const friendSpendToWin: number[] = []
  const friendAttemptsToWin: number[] = []
  const friendPotWhenWin: number[] = []
  const friendNetWhenWin: number[] = []
  const friendSpendPerAtt: number[] = []

  for (let p = 0; p < N; p++) {
    const rk = pick(rng, raiders).kind
    let spend = 0
    let atts = 0
    let won = false
    // Move across dungeons until this player gets a clear
    while (!won && atts < 500) {
      const ok = pick(rng, owners).kind
      planDungeon(ok, rng) // create exists; player doesn't pay create
      let kills = 0
      let dungeonLive = true
      while (dungeonLive && !won && kills < HARD.maxLiveWins && atts < 500) {
        atts++
        const raid = oneFriendRaid(rk, rng)
        spend += raid.spend
        friendSpendPerAtt.push(raid.spend)
        const bankNow = hardBankAfterKills(kills) + HARD.entryToBank
        if (rng() < raid.clearP) {
          const pot = hardRaiderClearPayout(bankNow)
          friendSpendToWin.push(spend)
          friendAttemptsToWin.push(atts)
          friendPotWhenWin.push(pot)
          friendNetWhenWin.push(pot - spend)
          won = true
          break
        }
        kills++
        const bank = hardBankAfterKills(kills)
        if (hardSuggestedClose(bank, kills, ownerCloseRoi(ok))) {
          dungeonLive = false // owner claimed — jump to next dungeon, keep spend
        }
      }
    }
  }

  console.log('══ Market (owner lives) ══')
  console.log(
    `  clear/attempt ${pct(ownerClears / ownerAttempts)}  · Friend takes dungeon ${pct(ownerClears / N)}  · Owner claims ${pct(ownerInvestClaim.length / N)}`,
  )

  console.log('\n══ Friend — средний расход, чтобы заработать (до первого вайпа) ══')
  console.log(`  players who won ${friendSpendToWin.length}/${N}`)
  console.log(`  mean $ spent until first win     $${mean(friendSpendToWin).toFixed(2)}`)
  console.log(
    `  p50 / p90 spend-to-win          $${quantile(friendSpendToWin, 0.5).toFixed(2)} / $${quantile(friendSpendToWin, 0.9).toFixed(2)}`,
  )
  console.log(`  mean attempts until win         ${mean(friendAttemptsToWin).toFixed(2)}`)
  console.log(
    `  mean pot on that win            $${mean(friendPotWhenWin).toFixed(2)}  (${(mean(friendPotWhenWin) / HARD.entryCost).toFixed(2)}× entry)`,
  )
  console.log(`  mean net (pot − all spend)      $${mean(friendNetWhenWin).toFixed(2)}`)
  console.log(`  mean $ per attempt              $${mean(friendSpendPerAtt).toFixed(2)}`)
  console.log(
    `  wins with spend ≤ $150          ${pct(friendSpendToWin.filter((x) => x <= 150).length / Math.max(1, friendSpendToWin.length))}`,
  )

  console.log('\n══ Dungeon owner — средний расход, чтобы заработать (успешный claim) ══')
  console.log(`  claims ${ownerInvestClaim.length}  · wiped ${ownerInvestWiped.length}`)
  console.log(`  mean $ invested to claim        $${mean(ownerInvestClaim).toFixed(2)}  (create $30 + rerolls)`)
  console.log(`  mean payout on claim            $${mean(ownerPayClaim).toFixed(2)}`)
  console.log(`  mean net on claim               $${mean(ownerNetClaim).toFixed(2)}`)
  console.log(`  mean ROI on claim               ${mean(ownerRoiClaim).toFixed(2)}×`)
  console.log(`  mean kills at claim             ${mean(ownerKillsClaim).toFixed(1)}`)
  console.log(`  mean $ lost when wiped          $${mean(ownerInvestWiped).toFixed(2)}`)

  const oInvestAll = mean([...ownerInvestClaim, ...ownerInvestWiped])
  const oPayAll = ownerPayClaim.reduce((a, b) => a + b, 0) / N
  console.log('\n══ Owner EV / life (incl. wipes = $0 bank claim) ══')
  console.log(`  mean invest all lives $${oInvestAll.toFixed(2)}  · mean claim payout/life $${oPayAll.toFixed(2)}  · net/life $${(oPayAll - oInvestAll).toFixed(2)}`)
  console.log('  (pool shares not included)')
}

main()
