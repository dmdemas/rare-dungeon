/**
 * Hard ×1000 lives — weekly pool tickets + bank OR.
 * Targets: Friend held wipe ~8–10× entry; owner bank+tickets ~2–3× create.
 *
 *   npx tsx scripts/sim-hard-tickets-1k.ts
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
  slashTicketsOnEarlyClaim,
  rerollCost,
  settleWeekPool,
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

/** Holders/whales hold into ~8–10× band for tickets; claimers can exit @2× but tickets slashed. */
function shouldClaim(ok: OwnerKind, bank: number, wins: number): boolean {
  if (ok === 'holder' || ok === 'whale') {
    if (wins < HARD.minWinsBeforeClaim) return false
    return (
      hardRaiderMultAtBank(bank) >= TICKET.holderExitRaiderX || wins >= TICKET.holderExitWins
    )
  }
  return hardSuggestedClose(bank, wins, HARD.suggestedCloseRoi)
}

function main() {
  const rng = mulberry32(0x71c00100)
  const owners = [
    { kind: 'claimer' as const, w: 0.2 },
    { kind: 'holder' as const, w: 0.55 },
    { kind: 'whale' as const, w: 0.25 },
  ]
  const raiders = [
    { kind: 'bare' as const, w: 0.25 },
    { kind: 'perk1' as const, w: 0.35 },
    { kind: 'perkHunt' as const, w: 0.25 },
    { kind: 'yolo' as const, w: 0.15 },
  ]

  console.log(
    `HARD × ${N} — weekly tickets (W2 wipe ${Math.round(TICKET.wipeToFriendFrac * 100)}/${Math.round(TICKET.wipeBurnFrac * 100)}) + bank`,
  )
  console.log(
    `create $${HARD.createCost} bank$${HARD.createToBank} fee$${HARD.createFee} · entry $${HARD.entryCost}`,
  )
  console.log(
    `TICKET unlock@${TICKET.unlockWins} mint×${TICKET.postUnlockMint} risk@${TICKET.riskWins}/×${TICKET.riskRaiderX} boost×${TICKET.riskBoost} hold+${TICKET.holdBonusPerWin}/win earlyClaimKeep=${TICKET.earlyClaimKeepFrac} holderExit×${TICKET.holderExitRaiderX}`,
  )
  console.log('Targets: Friend held ~8–10× · Owner bank+tickets ~2–3× create\n')

  let pool$ = 0
  let attempts = 0
  let clears = 0
  let claims = 0
  let ticketBurned = 0

  const ownerTickets = new Map<string, PoolTicket>()
  const friendTickets = new Map<string, PoolTicket>()
  /** Aggregate friend ledger for week settle (one bucket). */
  let friendPoolTicket = createTicket('FRIENDS')

  const friendPotsX: number[] = []
  const friendPotsXHeld: number[] = [] // wipe at wins≥7 (jackpot / held band)
  const friendPotsXBand: number[] = [] // kills 7..10
  const ownerBankRoi: number[] = []
  const ownerInvest: number[] = []
  const ownerClaimPay: number[] = []
  const ownerPowerAtEnd: number[] = []
  const killsOnClaim: number[] = []
  const killsOnWipe: number[] = []

  const ensureOwner = (id: string) => {
    let t = ownerTickets.get(id)
    if (!t) {
      t = createTicket(id)
      ownerTickets.set(id, t)
    }
    return t
  }

  for (let d = 0; d < N; d++) {
    const ok = pick(rng, owners).kind
    const ownerId = `owner-${ok}-${d}`
    const dungeonId = `d-${d}`
    const planned = planDungeon(ok, rng)
    pool$ += HARD.createFee + planned.createReroll$
    let ticket = ensureOwner(ownerId)
    const invest = planned.invest
    ownerInvest.push(invest)

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
        killsOnWipe.push(kills)
        const pot = hardRaiderClearPayout(bankNow)
        const x = pot / HARD.entryCost
        friendPotsX.push(x)
        if (kills >= 7) friendPotsXHeld.push(x)
        if (kills >= 7 && kills <= 10) friendPotsXBand.push(x)
        pool$ += bankNow * HARD.clearFeeFrac
        const tr = transferTicketsOnWipe(ticket, friendPoolTicket, dungeonId)
        ticket = tr.owner
        friendPoolTicket = tr.friend
        ticketBurned += tr.burned
        ownerTickets.set(ownerId, ticket)
        done = true
        break
      }

      kills++
      const bank = hardBankAfterKills(kills)
      const delta = ticketPowerOnCorpse({
        winsAfterKill: kills,
        bankAfterKill: bank,
        liveHardOwned: 1,
      })
      ticket = addTicketPower(ticket, dungeonId, delta)
      ownerTickets.set(ownerId, ticket)

      if (shouldClaim(ok, bank, kills)) {
        claims++
        killsOnClaim.push(kills)
        const pay = hardClosePayout(bank, kills)
        pool$ += bank * HARD.clearFeeFrac
        ownerClaimPay.push(pay)
        ownerBankRoi.push(hardRoi(pay, invest))
        ticket = slashTicketsOnEarlyClaim(ticket, dungeonId, kills)
        ownerTickets.set(ownerId, ticket)
        done = true
      }
    }
    if (!done) {
      claims++
      const bank = hardBankAfterKills(kills)
      killsOnClaim.push(kills)
      const pay = hardClosePayout(bank, kills)
      pool$ += bank * HARD.clearFeeFrac
      ownerClaimPay.push(pay)
      ownerBankRoi.push(hardRoi(pay, invest))
      ticket = slashTicketsOnEarlyClaim(ticket, dungeonId, kills)
      ownerTickets.set(ownerId, ticket)
    }
  }

  // Week end — Hard pot only (this run is Hard fees; Soft ledger empty)
  const hardTickets = [...ownerTickets.values(), friendPoolTicket]
  const week = settleWeekPool(pool$, [], hardTickets)
  // settleWeekPool puts 20% in soft pot unused — for Hard-only week use full pool on Hard tickets
  const hardPot = pool$ // all fees this run are Hard-sourced
  const totalPower = hardTickets.reduce((s, t) => s + t.power, 0)
  const payoutByOwner = new Map<string, number>()
  if (totalPower > 0) {
    for (const t of hardTickets) {
      if (t.power <= 0) continue
      payoutByOwner.set(t.ownerId, (hardPot * t.power) / totalPower)
    }
  }

  let ownerTicket$ = 0
  let friendTicket$ = 0
  for (const [id, pay] of payoutByOwner) {
    if (id === 'FRIENDS') friendTicket$ += pay
    else {
      ownerTicket$ += pay
      const t = ownerTickets.get(id)
      if (t) ownerPowerAtEnd.push(t.power)
    }
  }

  // Owner total ROI when claimed: bank + their ticket week pay
  const ownerTotalRoiClaim: number[] = []
  let oi = 0
  for (let d = 0; d < N; d++) {
    // approximate: only those who claimed have bank pay; ticket pay is per owner id
  }
  // Rebuild claim list with ticket
  // Simpler aggregate:
  const meanInvest = mean(ownerInvest)
  const meanBankIfClaim = mean(ownerClaimPay)
  const meanTicketPerOwnerLife = ownerTicket$ / N
  const meanTotalIfClaimOnly =
    claims > 0 ? meanBankIfClaim + ownerTicket$ / Math.max(1, claims) : 0

  // Per claimed life: match owner ids — we stored claim pays in order of claims only.
  // EV per life:
  const ownerEvPerLife = (ownerClaimPay.reduce((a, b) => a + b, 0) + ownerTicket$) / N - meanInvest

  console.log('══ Combat / who wins dungeon ══')
  console.log(`  Friend clear / attempt   ${pct(clears / attempts)}  (${clears}/${attempts})`)
  console.log(`  Friend takes dungeon     ${pct(clears / N)}  (${clears}/${N})`)
  console.log(`  Owner claims dungeon     ${pct(claims / N)}  (${claims}/${N})`)
  console.log(`  mean kills on wipe       ${mean(killsOnWipe).toFixed(1)}`)
  console.log(`  mean kills on claim      ${mean(killsOnClaim).toFixed(1)}`)

  console.log('\n══ Friend pot × (golden 8–10 on held k≥7) ══')
  console.log(`  mean × all wipes         ${mean(friendPotsX).toFixed(2)}×`)
  console.log(
    `  mean × held (k≥7)        ${friendPotsXHeld.length ? mean(friendPotsXHeld).toFixed(2) : 'n/a'}×  n=${friendPotsXHeld.length}`,
  )
  console.log(
    `  mean × band k=7–10       ${friendPotsXBand.length ? mean(friendPotsXBand).toFixed(2) : 'n/a'}×  n=${friendPotsXBand.length}`,
  )
  console.log(`  Friend ticket $ / week   $${friendTicket$.toFixed(0)}  (${pct(friendTicket$ / Math.max(1, hardPot))})`)

  console.log('\n══ Owner (golden 2–3× create with tickets) ══')
  console.log(`  mean invest              $${meanInvest.toFixed(2)}`)
  console.log(`  mean bank ROI if claim   ${mean(ownerBankRoi).toFixed(2)}×`)
  console.log(`  mean bank $ if claim     $${meanBankIfClaim.toFixed(2)}`)
  console.log(`  owner ticket $ / week    $${ownerTicket$.toFixed(0)}`)
  console.log(`  mean ticket $ / life     $${meanTicketPerOwnerLife.toFixed(2)}`)
  console.log(
    `  rough total if claim+tix  $${(meanBankIfClaim + meanTicketPerOwnerLife * (N / Math.max(1, claims))).toFixed(2)} → ~${((meanBankIfClaim + ownerTicket$ / Math.max(1, claims)) / meanInvest).toFixed(2)}× on create`,
  )
  const ownerEvRoi = (meanInvest + ownerEvPerLife) / meanInvest
  console.log(`  EV / life (all outcomes) $${ownerEvPerLife.toFixed(2)}  → ${ownerEvRoi.toFixed(2)}× create (golden 2–3×)`)
  console.log(
    `  note: bank alone @ minWins≥7 is already ~3.8×+; claim+tix path stays fat — judge owner OR by EV×`,
  )

  console.log('\n══ Pool / tickets ══')
  console.log(`  week pool$               $${pool$.toFixed(0)}`)
  console.log(`  total ticket power       ${totalPower.toFixed(1)}`)
  console.log(`  power burned on wipes    ${ticketBurned.toFixed(1)}`)
  console.log(`  settle unused soft pot note: Hard-only run assigns 100% pool to Hard tickets`)

  console.log('\n══ vs previous (no tickets, fee$3 bank$27, spend-1k) ══')
  console.log('  Before: clear/att ~17% · Friend takes ~82% · pot ~5.45× · owner claim ROI bank ~3.67× · owner EV/life ~−$10')
  console.log(
    `  Now:    clear/att ${pct(clears / attempts)} · Friend takes ${pct(clears / N)} · pot ${mean(friendPotsX).toFixed(2)}× · held ${friendPotsXHeld.length ? mean(friendPotsXHeld).toFixed(2) : 'n/a'}× · claim rate ${pct(claims / N)}`,
  )
}

main()
