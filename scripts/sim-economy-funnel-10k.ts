/**
 * Unified Soft → Hard economy funnel ×10k player sessions.
 *
 * Soft school (learn, easy wins) → optional graduate to Hard (spend, chase jackpot).
 * Uses current TICKET levers + Soft/Hard prices from economy.ts.
 * Combat: Soft clear ~35.8% (soft-1k); Hard perk clearP (tickets-1k path).
 *
 *   npx tsx scripts/sim-economy-funnel-10k.ts
 * Writes: economy-funnel-10k-out.txt
 */
import { writeFileSync } from 'node:fs'
import {
  HARD,
  SOFT,
  TICKET,
  addTicketPower,
  createTicket,
  hardBankAfterKills,
  hardClosePayout,
  hardRaiderClearPayout,
  hardRaiderMultAtBank,
  hardRoi,
  hardSuggestedClose,
  rerollCost,
  slashTicketsOnEarlyClaim,
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

const N = 10_000
const START_BANKROLL = 80
const SOFT_CLEAR_P = 0.358 // soft-1k Friend clear / attempt
const SOFT_POT_MEAN_X = 2.61

type SoftKind = 'school_then_hard' | 'cautious' | 'soft_lifer' | 'skip_school'
type HardRaider = 'bare' | 'perk1' | 'perkHunt' | 'yolo'
type OwnerKind = 'claimer' | 'holder' | 'whale'

const SOFT_KINDS: { kind: SoftKind; w: number }[] = [
  { kind: 'school_then_hard', w: 0.45 },
  { kind: 'cautious', w: 0.25 },
  { kind: 'soft_lifer', w: 0.15 },
  { kind: 'skip_school', w: 0.15 },
]

const HARD_RAIDERS: { kind: HardRaider; w: number }[] = [
  { kind: 'bare', w: 0.25 },
  { kind: 'perk1', w: 0.35 },
  { kind: 'perkHunt', w: 0.25 },
  { kind: 'yolo', w: 0.15 },
]

const OWNERS: { kind: OwnerKind; w: number }[] = [
  { kind: 'claimer', w: 0.2 },
  { kind: 'holder', w: 0.55 },
  { kind: 'whale', w: 0.25 },
]

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
function median(xs: number[]) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
function quantile(xs: number[], q: number) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))
  return s[i]!
}

function maxR(kind: OwnerKind | HardRaider, i: number, rng: () => number): number {
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

function friendRaid(rk: HardRaider, rng: () => number) {
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

function shouldClaim(ok: OwnerKind, bank: number, wins: number): boolean {
  if (ok === 'holder' || ok === 'whale') {
    if (wins < HARD.minWinsBeforeClaim) return false
    return hardRaiderMultAtBank(bank) >= TICKET.holderExitRaiderX || wins >= TICKET.holderExitWins
  }
  return hardSuggestedClose(bank, wins, HARD.suggestedCloseRoi)
}

/** Soft school → Hard? One decision after Soft phase (archetype × Soft success). */
function wantsHard(
  kind: SoftKind,
  softClears: number,
  softAttempts: number,
  softPnL: number,
  rng: () => number,
): boolean {
  if (softClears <= 0) {
    if (kind === 'skip_school') return softAttempts >= 1 && rng() < 0.55
    if (softAttempts >= 6 && kind !== 'soft_lifer') return rng() < 0.22 // tilt after dry Soft
    return false
  }
  // Soft success path — design lean: majority of Soft winners try Hard, not everyone
  if (kind === 'soft_lifer') return rng() < 0.12
  if (kind === 'school_then_hard') return rng() < (softClears >= 2 ? 0.78 : 0.65)
  if (kind === 'cautious') {
    if (softClears >= 2 && softPnL > 0) return rng() < 0.48
    if (softClears >= 1) return rng() < 0.22
    return false
  }
  return rng() < 0.7 // skip_school after Soft win
}

function softSchoolDone(kind: SoftKind, softClears: number, softAttempts: number): boolean {
  if (kind === 'soft_lifer') return softAttempts >= 12 || softClears >= 4
  if (kind === 'cautious') return softClears >= 3 || softAttempts >= 10
  if (kind === 'school_then_hard') return softClears >= 2 || softAttempts >= 8
  return softAttempts >= 3 || softClears >= 1 // skip_school: short Soft
}

type HardDungeon = {
  id: string
  ownerId: string
  ok: OwnerKind
  invest: number
  kills: number
  ticket: PoolTicket
  alive: boolean
}

function main() {
  const rng = mulberry32(0xec0f001)
  const lines: string[] = []
  const log = (s = '') => {
    lines.push(s)
    console.log(s)
  }

  log(`UNIFIED Soft→Hard funnel × ${N} sessions`)
  log(`start bankroll $${START_BANKROLL} · Soft clearP ${SOFT_CLEAR_P} · Soft pot ~${SOFT_POT_MEAN_X}×`)
  log(
    `Hard entry $${HARD.entryCost} · TICKET risk×${TICKET.riskBoost} post×${TICKET.postUnlockMint} hold+${TICKET.holdBonusPerWin} W2 ${Math.round(TICKET.wipeToFriendFrac * 100)}/${Math.round(TICKET.wipeBurnFrac * 100)}`,
  )
  log(
    'Note: Soft→Hard convert is a behavior model (archetypes), not an econ output — bankroll gate still applies.',
  )
  log('')

  // ── Spawn Hard dungeon pool (owners) so graduates have something to raid ──
  const HARD_DUNGEONS = Math.max(400, Math.floor(N * 0.08))
  let pool$ = 0
  const ownerTickets = new Map<string, PoolTicket>()
  let friendPoolTicket = createTicket('FRIENDS')
  let ticketBurned = 0
  const hardPool: HardDungeon[] = []

  for (let i = 0; i < HARD_DUNGEONS; i++) {
    const ok = pick(rng, OWNERS).kind
    const ownerId = `hard-owner-${ok}-${i}`
    const dungeonId = `hd-${i}`
    const planned = planDungeon(ok, rng)
    pool$ += HARD.createFee + planned.createReroll$
    const ticket = createTicket(ownerId)
    ownerTickets.set(ownerId, ticket)
    hardPool.push({
      id: dungeonId,
      ownerId,
      ok,
      invest: planned.invest,
      kills: 0,
      ticket,
      alive: true,
    })
  }

  // Soft dungeon banks: lightweight — Friend clears against a typical Soft bank (~k=1–2)
  // Soft fees → pool too
  let softCreates = Math.floor(N * 0.35)
  pool$ += softCreates * SOFT.createFee

  // ── Player sessions ──
  let softAttempts = 0
  let softClears = 0
  let softSpend = 0
  let softWon = 0

  let triedHard = 0
  let triedHardAfterSoftWin = 0
  let softWinners = 0
  let softNoWin = 0
  let triedHardNoSoftWin = 0

  let hardAttempts = 0
  let hardClears = 0
  let hardSpend = 0
  let hardWon = 0
  let hardHeldJackpots = 0 // wipe at k≥7
  const hardPotsX: number[] = []
  const hardPotsXHeld: number[] = []

  const endBal: number[] = []
  const softPnLs: number[] = []
  const hardPnLsAll: number[] = []
  const hardPnLsGrad: number[] = []
  const totalPnLs: number[] = []
  let bankrupt = 0
  let softOnlyFinish = 0

  const convertByKind: Record<SoftKind, { n: number; softWin: number; hard: number; hardAfterWin: number }> = {
    school_then_hard: { n: 0, softWin: 0, hard: 0, hardAfterWin: 0 },
    cautious: { n: 0, softWin: 0, hard: 0, hardAfterWin: 0 },
    soft_lifer: { n: 0, softWin: 0, hard: 0, hardAfterWin: 0 },
    skip_school: { n: 0, softWin: 0, hard: 0, hardAfterWin: 0 },
  }

  const ownerClaims: { pay: number; invest: number; ownerId: string }[] = []
  let hardDungeonWipes = 0
  let hardDungeonClaims = 0
  let nextHardIdx = HARD_DUNGEONS

  const ensureAliveHard = (): HardDungeon | null => {
    const alive = hardPool.filter((d) => d.alive)
    if (alive.length) return alive[Math.floor(rng() * alive.length)]!
    // Respawn a replacement Hard dungeon (create glut refill)
    const ok = pick(rng, OWNERS).kind
    const ownerId = `hard-owner-${ok}-${nextHardIdx}`
    const dungeonId = `hd-${nextHardIdx++}`
    const planned = planDungeon(ok, rng)
    pool$ += HARD.createFee + planned.createReroll$
    const ticket = createTicket(ownerId)
    ownerTickets.set(ownerId, ticket)
    const d: HardDungeon = {
      id: dungeonId,
      ownerId,
      ok,
      invest: planned.invest,
      kills: 0,
      ticket,
      alive: true,
    }
    hardPool.push(d)
    return d
  }

  for (let p = 0; p < N; p++) {
    const kind = pick(rng, SOFT_KINDS).kind
    convertByKind[kind].n++
    let bal = START_BANKROLL
    let sAtt = 0
    let sClr = 0
    let sSpend = 0
    let sWon = 0
    let graduated = false
    let didHard = false

    // Soft school
    while (bal >= SOFT.entryCost && !softSchoolDone(kind, sClr, sAtt)) {
      bal -= SOFT.entryCost
      sSpend += SOFT.entryCost
      softSpend += SOFT.entryCost
      pool$ += SOFT.entryToOwnerPool
      softAttempts++
      sAtt++

      if (rng() < SOFT_CLEAR_P) {
        // Typical Soft pot ~2.61× with noise
        const x = SOFT_POT_MEAN_X * (0.85 + rng() * 0.3)
        const pot = SOFT.entryCost * x
        bal += pot
        sWon += pot
        softWon += pot
        softClears++
        sClr++
        pool$ += (pot / SOFT.clearRaiderFrac) * SOFT.clearFeeFrac
      }
    }

    // One-shot Soft→Hard decision after school (not every raid — avoids 1−(1−p)^n ≈ 100%)
    graduated = wantsHard(kind, sClr, sAtt, sWon - sSpend, rng)

    const softPnL = sWon - sSpend
    softPnLs.push(softPnL)
    if (sClr >= 1) {
      softWinners++
      convertByKind[kind].softWin++
    } else softNoWin++

    const goHard = graduated && bal >= HARD.entryCost
    if (goHard) {
      didHard = true
      triedHard++
      convertByKind[kind].hard++
      if (sClr >= 1) {
        triedHardAfterSoftWin++
        convertByKind[kind].hardAfterWin++
      } else {
        triedHardNoSoftWin++
      }
    } else if (sClr >= 1 && !didHard) {
      softOnlyFinish++
    }

    let hSpend = 0
    let hWon = 0
    let hAtt = 0

    // Hard chase (bankroll guard ~9 entries)
    while (didHard && bal >= HARD.entryCost && hAtt < 9) {
      const d = ensureAliveHard()
      if (!d) break
      const rk = pick(rng, HARD_RAIDERS).kind
      const fr = friendRaid(rk, rng)
      const entryPaid = HARD.entryCost + fr.reroll$
      if (bal < entryPaid) break

      bal -= entryPaid
      hSpend += entryPaid
      hardSpend += entryPaid
      pool$ += HARD.entryToOwnerPool + fr.reroll$
      hardAttempts++
      hAtt++

      const bankNow = hardBankAfterKills(d.kills) + HARD.entryToBank
      if (rng() < fr.p) {
        // Friend wipe
        hardClears++
        hardDungeonWipes++
        const pot = hardRaiderClearPayout(bankNow)
        const x = pot / HARD.entryCost
        hardPotsX.push(x)
        if (d.kills >= 7) {
          hardPotsXHeld.push(x)
          hardHeldJackpots++
        }
        bal += pot
        hWon += pot
        hardWon += pot
        pool$ += bankNow * HARD.clearFeeFrac

        const ownerT = ownerTickets.get(d.ownerId) ?? d.ticket
        const tr = transferTicketsOnWipe(ownerT, friendPoolTicket, d.id)
        ownerTickets.set(d.ownerId, tr.owner)
        friendPoolTicket = tr.friend
        ticketBurned += tr.burned
        d.alive = false
        continue
      }

      // Corpse — dungeon holds
      d.kills++
      const bank = hardBankAfterKills(d.kills)
      const delta = ticketPowerOnCorpse({
        winsAfterKill: d.kills,
        bankAfterKill: bank,
        liveHardOwned: 1,
      })
      d.ticket = addTicketPower(
        ownerTickets.get(d.ownerId) ?? d.ticket,
        d.id,
        delta,
      )
      ownerTickets.set(d.ownerId, d.ticket)

      if (shouldClaim(d.ok, bank, d.kills)) {
        hardDungeonClaims++
        const pay = hardClosePayout(bank, d.kills)
        pool$ += bank * HARD.clearFeeFrac
        ownerClaims.push({ pay, invest: d.invest, ownerId: d.ownerId })
        d.ticket = slashTicketsOnEarlyClaim(d.ticket, d.id, d.kills)
        ownerTickets.set(d.ownerId, d.ticket)
        d.alive = false
      }
    }

    const hardPnL = hWon - hSpend
    hardPnLsAll.push(hardPnL)
    if (didHard) hardPnLsGrad.push(hardPnL)
    const totalPnL = bal - START_BANKROLL
    totalPnLs.push(totalPnL)
    endBal.push(bal)
    if (bal < SOFT.entryCost) bankrupt++
  }

  // Flush remaining Hard claims at week end (force close surviving)
  for (const d of hardPool) {
    if (!d.alive || d.kills < HARD.minWinsBeforeClaim) continue
    const bank = hardBankAfterKills(d.kills)
    const pay = hardClosePayout(bank, d.kills)
    pool$ += bank * HARD.clearFeeFrac
    ownerClaims.push({ pay, invest: d.invest, ownerId: d.ownerId })
    d.ticket = slashTicketsOnEarlyClaim(d.ticket, d.id, d.kills)
    ownerTickets.set(d.ownerId, d.ticket)
    d.alive = false
    hardDungeonClaims++
  }

  // Week ticket settle — Hard-sourced fees dominate; assign full pool to Hard tickets for this run
  const hardTickets = [...ownerTickets.values(), friendPoolTicket]
  const totalPower = hardTickets.reduce((s, t) => s + t.power, 0)
  let ownerTicket$ = 0
  let friendTicket$ = 0
  if (totalPower > 0) {
    for (const t of hardTickets) {
      if (t.power <= 0) continue
      const pay = (pool$ * t.power) / totalPower
      if (t.ownerId === 'FRIENDS') friendTicket$ += pay
      else ownerTicket$ += pay
    }
  }

  const claimPays = ownerClaims.map((c) => c.pay)
  const claimRois = ownerClaims.map((c) => hardRoi(c.pay, c.invest))
  const ownerEvPerCreate =
    ownerClaims.length > 0
      ? (claimPays.reduce((a, b) => a + b, 0) + ownerTicket$) / Math.max(1, hardPool.length) -
        mean(ownerClaims.map((c) => c.invest))
      : 0

  // ── Report ──
  log('══ Funnel Soft → Hard ══')
  log(`  Soft winners (≥1 clear)     ${softWinners}  ${pct(softWinners / N)}`)
  log(`  Soft no-win                 ${softNoWin}  ${pct(softNoWin / N)}`)
  log(`  Tried Hard (any)            ${triedHard}  ${pct(triedHard / N)}`)
  log(
    `  Soft win → Hard             ${triedHardAfterSoftWin} / ${softWinners}  = ${pct(softWinners ? triedHardAfterSoftWin / softWinners : 0)}  ★`,
  )
  log(
    `  No Soft win → Hard          ${triedHardNoSoftWin} / ${softNoWin}  = ${pct(softNoWin ? triedHardNoSoftWin / softNoWin : 0)}`,
  )
  log(`  Soft win & stayed Soft-only ${softOnlyFinish}  ${pct(softOnlyFinish / N)}`)
  log('')
  log('  Convert Soft-win→Hard by archetype:')
  for (const k of Object.keys(convertByKind) as SoftKind[]) {
    const b = convertByKind[k]
    const rate = b.softWin ? b.hardAfterWin / b.softWin : 0
    log(
      `    ${k.padEnd(18)} n=${b.n} softWin=${b.softWin} hardAfterWin=${b.hardAfterWin} → ${pct(rate)}`,
    )
  }

  log('\n══ Soft school ══')
  log(`  attempts ${softAttempts}  clear/att ${pct(softAttempts ? softClears / softAttempts : 0)}`)
  log(`  spend $${softSpend.toFixed(0)}  won $${softWon.toFixed(0)}  net $${(softWon - softSpend).toFixed(0)}`)
  log(`  mean Soft PnL / player  $${mean(softPnLs).toFixed(2)}  median $${median(softPnLs).toFixed(2)}`)

  log('\n══ Hard chase (graduates) ══')
  log(`  attempts ${hardAttempts}  clear/att ${pct(hardAttempts ? hardClears / hardAttempts : 0)}`)
  log(`  spend $${hardSpend.toFixed(0)}  won $${hardWon.toFixed(0)}  net $${(hardWon - hardSpend).toFixed(0)}`)
  log(
    `  pot × all wipes ${hardPotsX.length ? mean(hardPotsX).toFixed(2) : 'n/a'}×  held k≥7 ${hardPotsXHeld.length ? mean(hardPotsXHeld).toFixed(2) : 'n/a'}× n=${hardPotsXHeld.length}`,
  )
  log(`  held jackpots (player view) ${hardHeldJackpots}`)
  log(
    `  mean Hard PnL / graduate  $${mean(hardPnLsGrad).toFixed(2)}  median $${median(hardPnLsGrad).toFixed(2)}`,
  )
  log(`  mean Hard PnL / all players $${mean(hardPnLsAll).toFixed(2)}`)
  log(
    `  $ Soft : $ Hard spend ratio  1 : ${(hardSpend / Math.max(1, softSpend)).toFixed(2)}`,
  )

  log('\n══ Bankroll / viability ══')
  log(`  start $${START_BANKROLL}`)
  log(
    `  end mean $${mean(endBal).toFixed(2)}  median $${median(endBal).toFixed(2)}  p10 $${quantile(endBal, 0.1).toFixed(0)}  p90 $${quantile(endBal, 0.9).toFixed(0)}`,
  )
  log(`  mean total PnL $${mean(totalPnLs).toFixed(2)}  median $${median(totalPnLs).toFixed(2)}`)
  log(`  bankrupt (<$1) ${bankrupt}  ${pct(bankrupt / N)}`)
  log(
    `  ended ≥ start  ${endBal.filter((b) => b >= START_BANKROLL).length}  ${pct(endBal.filter((b) => b >= START_BANKROLL).length / N)}`,
  )

  log('\n══ Hard owners + tickets (week) ══')
  log(`  Hard dungeons spawned/refilled ~${hardPool.length}`)
  log(`  dungeon wipes ${hardDungeonWipes}  claims ${hardDungeonClaims}`)
  log(
    `  owner bank ROI if claim ${claimRois.length ? mean(claimRois).toFixed(2) : 'n/a'}×  n=${claimRois.length}`,
  )
  log(`  week pool$ $${pool$.toFixed(0)}  ticket power ${totalPower.toFixed(0)}  burned ${ticketBurned.toFixed(0)}`)
  log(
    `  Friend ticket $ ${friendTicket$.toFixed(0)} (${pct(pool$ ? friendTicket$ / pool$ : 0)})  Owner ticket $ ${ownerTicket$.toFixed(0)} (${pct(pool$ ? ownerTicket$ / pool$ : 0)})`,
  )
  log(`  rough owner EV/create (bank+tix vs invest, crude) $${ownerEvPerCreate.toFixed(2)}`)

  log('\n══ Verdict ══')
  const conv = softWinners ? triedHardAfterSoftWin / softWinners : 0
  const softOk = softAttempts > 0 && softClears / softAttempts >= 0.3 && softClears / softAttempts <= 0.4
  const hardHarder = hardAttempts > 0 && hardClears / hardAttempts < softClears / softAttempts
  const spendShift = hardSpend > softSpend
  const heldOk = hardPotsXHeld.length > 0 && mean(hardPotsXHeld) >= 8 && mean(hardPotsXHeld) <= 10.5
  log(`  Soft→Hard after Soft win: ${pct(conv)} ${conv >= 0.45 && conv <= 0.75 ? '✓ funnel alive (~half Soft winners graduate)' : conv < 0.45 ? '⚠ low convert' : '⚠ very high convert'}`)
  log(`  Soft clear band: ${softOk ? '✓' : '⚠'} (${pct(softAttempts ? softClears / softAttempts : 0)})`)
  log(`  Hard harder than Soft: ${hardHarder ? '✓' : '✗'}`)
  log(`  $ flows Soft→Hard (Hard spend > Soft): ${spendShift ? '✓' : '✗'} (${(hardSpend / Math.max(1, softSpend)).toFixed(2)}× Soft)`)
  log(`  Held jackpot × band: ${heldOk ? '✓' : '⚠'} (${hardPotsXHeld.length ? mean(hardPotsXHeld).toFixed(2) : 'n/a'}×)`)
  log(
    `  Player bankroll: median ${median(endBal) >= START_BANKROLL * 0.55 ? 'survives school+Hard bleed' : 'heavy bleed'} (median end $${median(endBal).toFixed(0)})`,
  )

  writeFileSync('economy-funnel-10k-out.txt', lines.join('\n'), 'utf8')
  log('\nWrote economy-funnel-10k-out.txt')
}

main()
