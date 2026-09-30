/**
 * Sweep ticket levers so holders keep Hard live → Friend wipe pots ~8–10×.
 *
 *   npx tsx scripts/sim-hard-tickets-hold-sweep.ts
 */
import {
  HARD,
  TICKET,
  addTicketPower,
  createTicket,
  hardBankAfterKills,
  hardClosePayout,
  hardRaiderClearPayout,
  hardRaiderMultAtBank,
  hardRoi,
  hardSuggestedClose,
  lockTicketsOnClaim,
  rerollCost,
  ticketPowerOnCorpse,
  transferTicketsOnWipe,
  type PoolTicket,
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

type Lever = {
  name: string
  /** Keep this fraction of dungeon ticket power if claim before unlockWins. */
  earlyClaimKeep: number
  unlockWins: number
  /** Extra mult on Δpower when wins ≥ unlockWins. */
  postUnlockMint: number
  riskWins: number
  riskBoost: number
  /** Owner mix weights. */
  claimerW: number
  holderW: number
  whaleW: number
  /** Holder exits when raider× ≥ this (high = hold longer). */
  holderExitX: number
  holderExitWins: number
  /** If true, claimers also use holder exit (full anti-claim meta). */
  everyoneHolds: boolean
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

function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}
function pct(x: number) {
  return `${(100 * x).toFixed(1)}%`
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

function clearP(ranks: Partial<Record<FriendPerkId, number>>): number {
  const dash = ranks.dash ?? 0
  const lift = dash === 0 ? 0 : dash === 1 ? 0.04 : dash === 2 ? 0.09 : 0.14
  const other =
    ((ranks.fearless ?? 0) + (ranks.sharpEye ?? 0) + (ranks.endurance ?? 0)) * 0.008
  return Math.min(0.25, 0.1 + lift + other)
}

function planDungeon(ok: OwnerKind, rng: () => number) {
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
  return { createReroll$: already.$, invest: HARD.createCost + already.$ }
}

function friendRaid(rk: RaiderKind, rng: () => number) {
  let perks: PerksState = createEmptyPerksState()
  const already = { n: 0, $: 0 }
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
  return { reroll$: already.$, p: clearP(perks.friend.ranks) }
}

function powerOnCorpse(wins: number, bank: number, lever: Lever): number {
  const mult = hardRaiderMultAtBank(bank)
  const hold = 1 + TICKET.holdBonusPerWin * Math.max(0, wins - 1)
  const risk = wins >= lever.riskWins || mult >= TICKET.riskRaiderX ? lever.riskBoost : 1
  const post = wins >= lever.unlockWins ? lever.postUnlockMint : 1
  return Math.round(1 * hold * risk * post * 1000) / 1000
}

function slashOnEarlyClaim(ticket: PoolTicket, dungeonId: string, wins: number, lever: Lever): PoolTicket {
  const att = ticket.byDungeon[dungeonId] ?? 0
  if (att <= 0) return lockTicketsOnClaim(ticket, dungeonId)
  if (wins >= lever.unlockWins) return lockTicketsOnClaim(ticket, dungeonId)
  const keep = att * lever.earlyClaimKeep
  const lost = att - keep
  const { [dungeonId]: _, ...rest } = ticket.byDungeon
  return {
    ...ticket,
    power: Math.max(0, ticket.power - lost),
    byDungeon: keep > 0 ? { ...rest, [dungeonId]: keep } : rest,
  }
}

function shouldClaim(ok: OwnerKind, bank: number, wins: number, lever: Lever): boolean {
  if (lever.everyoneHolds || ok === 'holder') {
    if (wins < HARD.minWinsBeforeClaim) return false
    return hardRaiderMultAtBank(bank) >= lever.holderExitX || wins >= lever.holderExitWins
  }
  if (ok === 'whale') {
    if (wins < HARD.minWinsBeforeClaim) return false
    // whales hold into risk zone for tickets unless bank ROI absurd
    if (wins < lever.unlockWins) return false
    return hardSuggestedClose(bank, wins, 2.5) && hardRaiderMultAtBank(bank) >= 8
  }
  // claimer: still can claim at 2× but tickets slashed if early
  return hardSuggestedClose(bank, wins, HARD.suggestedCloseRoi)
}

function run(lever: Lever, seed: number) {
  const rng = mulberry32(seed)
  const owners = [
    { kind: 'claimer' as const, w: lever.claimerW },
    { kind: 'holder' as const, w: lever.holderW },
    { kind: 'whale' as const, w: lever.whaleW },
  ]
  const raiders = [
    { kind: 'bare' as const, w: 0.25 },
    { kind: 'perk1' as const, w: 0.35 },
    { kind: 'perkHunt' as const, w: 0.25 },
    { kind: 'yolo' as const, w: 0.15 },
  ]

  let pool$ = 0
  let attempts = 0
  let clears = 0
  let claims = 0
  const potsX: number[] = []
  const potsXBand: number[] = [] // wipe when kills 7..10 (8–10× band)
  const potsXHeld: number[] = [] // kills≥7
  const killsWipe: number[] = []
  const killsClaim: number[] = []
  const ownerTickets = new Map<string, PoolTicket>()
  let friendTicket = createTicket('FRIENDS')
  const claimPays: number[] = []
  const invests: number[] = []

  const ensure = (id: string) => {
    let t = ownerTickets.get(id)
    if (!t) {
      t = createTicket(id)
      ownerTickets.set(id, t)
    }
    return t
  }

  for (let d = 0; d < N; d++) {
    const ok = pick(rng, owners).kind
    const ownerId = `o-${ok}-${d}`
    const dungeonId = `d-${d}`
    const planned = planDungeon(ok, rng)
    pool$ += HARD.createFee + planned.createReroll$
    invests.push(planned.invest)
    let ticket = ensure(ownerId)
    let kills = 0
    let done = false

    while (!done && kills < HARD.maxLiveWins) {
      attempts++
      const rk = pick(rng, raiders).kind
      const fr = friendRaid(rk, rng)
      pool$ += HARD.entryToOwnerPool + fr.reroll$
      const bankNow = hardBankAfterKills(kills) + HARD.entryToBank

      if (rng() < fr.p) {
        clears++
        const pot = hardRaiderClearPayout(bankNow)
        const x = pot / HARD.entryCost
        potsX.push(x)
        killsWipe.push(kills)
        if (kills >= 7) potsXHeld.push(x)
        if (kills >= 7 && kills <= 10) potsXBand.push(x)
        pool$ += bankNow * HARD.clearFeeFrac
        const tr = transferTicketsOnWipe(ticket, friendTicket, dungeonId)
        ticket = tr.owner
        friendTicket = tr.friend
        ownerTickets.set(ownerId, ticket)
        done = true
        break
      }

      kills++
      const bank = hardBankAfterKills(kills)
      const delta = powerOnCorpse(kills, bank, lever)
      ticket = addTicketPower(ticket, dungeonId, delta)
      ownerTickets.set(ownerId, ticket)

      if (shouldClaim(ok, bank, kills, lever)) {
        claims++
        killsClaim.push(kills)
        const pay = hardClosePayout(bank, kills)
        claimPays.push(pay)
        pool$ += bank * HARD.clearFeeFrac
        ticket = slashOnEarlyClaim(ticket, dungeonId, kills, lever)
        ticket = lockTicketsOnClaim(ticket, dungeonId)
        ownerTickets.set(ownerId, ticket)
        done = true
      }
    }
    if (!done) {
      claims++
      const bank = hardBankAfterKills(kills)
      killsClaim.push(kills)
      const pay = hardClosePayout(bank, kills)
      claimPays.push(pay)
      pool$ += bank * HARD.clearFeeFrac
      ticket = slashOnEarlyClaim(ticket, dungeonId, kills, lever)
      ticket = lockTicketsOnClaim(ticket, dungeonId)
      ownerTickets.set(ownerId, ticket)
    }
  }

  const hardTickets = [...ownerTickets.values(), friendTicket]
  const totalPower = hardTickets.reduce((s, t) => s + t.power, 0)
  let ownerTix$ = 0
  let friendTix$ = 0
  if (totalPower > 0) {
    for (const t of hardTickets) {
      const pay = (pool$ * t.power) / totalPower
      if (t.ownerId === 'FRIENDS') friendTix$ += pay
      else ownerTix$ += pay
    }
  }

  const meanInvest = mean(invests)
  const ownerEv =
    (claimPays.reduce((a, b) => a + b, 0) + ownerTix$) / N - meanInvest

  return {
    lever: lever.name,
    clearAtt: clears / attempts,
    friendTake: clears / N,
    claimRate: claims / N,
    meanPotX: mean(potsX),
    meanPotHeldX: mean(potsXHeld),
    meanPotBandX: mean(potsXBand),
    nHeld: potsXHeld.length,
    nBand: potsXBand.length,
    meanKillWipe: mean(killsWipe),
    meanKillClaim: mean(killsClaim),
    ownerEv,
    ownerTix$,
    friendTix$,
    pool$,
    // score: how close held mean is to 9×, and overall mean toward 7+
    score:
      (potsXHeld.length < 30 ? -5 : 0) +
      -Math.abs((mean(potsXHeld) || 0) - 9) +
      -Math.abs((mean(potsX) || 0) - 7) * 0.35 +
      (mean(potsXHeld) >= 8 && mean(potsXHeld) <= 10.5 ? 3 : 0),
  }
}

function main() {
  console.log('Sweep: ticket levers → Friend wipe ~8–10× (held) via longer hold\n')

  const levers: Lever[] = [
    {
      name: 'BASE (prev)',
      earlyClaimKeep: 1,
      unlockWins: 10,
      postUnlockMint: 1,
      riskWins: 10,
      riskBoost: 3,
      claimerW: 0.35,
      holderW: 0.4,
      whaleW: 0.25,
      holderExitX: 9,
      holderExitWins: 12,
      everyoneHolds: false,
    },
    {
      name: 'SLASH early claim keep=0',
      earlyClaimKeep: 0,
      unlockWins: 10,
      postUnlockMint: 2,
      riskWins: 7,
      riskBoost: 4,
      claimerW: 0.25,
      holderW: 0.5,
      whaleW: 0.25,
      holderExitX: 11,
      holderExitWins: 14,
      everyoneHolds: false,
    },
    {
      name: 'SLASH+mint×3 risk@7 hold→12×',
      earlyClaimKeep: 0.1,
      unlockWins: 7,
      postUnlockMint: 3,
      riskWins: 7,
      riskBoost: 5,
      claimerW: 0.2,
      holderW: 0.55,
      whaleW: 0.25,
      holderExitX: 12,
      holderExitWins: 16,
      everyoneHolds: false,
    },
    {
      name: 'ALL HOLD until ×10 / w15',
      earlyClaimKeep: 0,
      unlockWins: 7,
      postUnlockMint: 2.5,
      riskWins: 7,
      riskBoost: 4,
      claimerW: 0.15,
      holderW: 0.6,
      whaleW: 0.25,
      holderExitX: 10.2,
      holderExitWins: 15,
      everyoneHolds: true,
    },
    {
      name: 'ALL HOLD exit ×9.5 w11 (jackpot band)',
      earlyClaimKeep: 0,
      unlockWins: 7,
      postUnlockMint: 4,
      riskWins: 7,
      riskBoost: 5,
      claimerW: 0.1,
      holderW: 0.65,
      whaleW: 0.25,
      holderExitX: 9.5,
      holderExitWins: 11,
      everyoneHolds: true,
    },
    {
      name: 'HOLD×9.2 soft slash keep=0.15',
      earlyClaimKeep: 0.15,
      unlockWins: 8,
      postUnlockMint: 3,
      riskWins: 8,
      riskBoost: 4,
      claimerW: 0.2,
      holderW: 0.55,
      whaleW: 0.25,
      holderExitX: 9.2,
      holderExitWins: 12,
      everyoneHolds: false,
    },
    {
      name: 'EXTREME hold exit ×10.5 / mint×5',
      earlyClaimKeep: 0,
      unlockWins: 7,
      postUnlockMint: 5,
      riskWins: 7,
      riskBoost: 6,
      claimerW: 0.1,
      holderW: 0.7,
      whaleW: 0.2,
      holderExitX: 10.5,
      holderExitWins: 18,
      everyoneHolds: true,
    },
  ]

  const rows = levers.map((l, i) => run(l, 0x51a00000 + i * 7919))
  rows.sort((a, b) => b.score - a.score)

  for (const r of rows) {
    console.log(`── ${r.lever}  score=${r.score.toFixed(2)}`)
    console.log(
      `  clear/att ${pct(r.clearAtt)} · FriendTake ${pct(r.friendTake)} · claim ${pct(r.claimRate)}`,
    )
    console.log(
      `  pot× all ${r.meanPotX.toFixed(2)} · held(k≥7) ${r.meanPotHeldX.toFixed(2)} (n=${r.nHeld}) · band7–10 ${r.meanPotBandX.toFixed(2)} (n=${r.nBand})`,
    )
    console.log(
      `  kills wipe/claim ${r.meanKillWipe.toFixed(1)}/${r.meanKillClaim.toFixed(1)} · ownerEV $${r.ownerEv.toFixed(2)} · tix owner/friend $${r.ownerTix$.toFixed(0)}/$${r.friendTix$.toFixed(0)}`,
    )
    console.log('')
  }

  const best = rows[0]!
  console.log('BEST:', best.lever)
  console.log(
    `  Friend held× ${best.meanPotHeldX.toFixed(2)} (want 8–10) · all× ${best.meanPotX.toFixed(2)} · FriendTake ${pct(best.friendTake)}`,
  )
}

main()
