/**
 * Economy integration invariants check.
 * Verifies that pool math, claim tax, ticket mint, wipe transfer,
 * and week settlement all conserve money and obey design rules.
 *
 *   npx tsx scripts/sim-integration-check.ts
 */
import {
  HARD,
  TICKET,
  TICKET_POOL_FRAC,
  PROTOCOL_WEEKLY_BURN_FRAC,
  addTicketPower,
  claimTaxFrac,
  createTicket,
  createWallet,
  credit,
  applyProtocolFee,
  hardBankAfterKills,
  settleHardClaimWithTax,
  settleHardCreate,
  settleHardEntry,
  slashTicketsOnEarlyClaim,
  ticketMintAtWin,
  transferTicketsOnWipe,
} from '../src/game/economy.ts'

// ── Helpers ──────────────────────────────────────────────────────────────────

let passCount = 0
let failCount = 0

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✅ ${name}`)
    passCount++
  } else {
    console.log(`  ❌ ${name}${detail ? `  →  ${detail}` : ''}`)
    failCount++
  }
}

function near(a: number, b: number, eps = 0.001): boolean {
  return Math.abs(a - b) <= eps
}

// ── Invariant 1: Money conservation through create + entry ────────────────────

console.log('\n── Invariant 1: Money conservation ──────────────────────────────')

{
  const START = 1000
  let wallet = createWallet(START)

  // Hard create
  const created = settleHardCreate(wallet, 0)
  if (!created) { check('settleHardCreate returned result', false); process.exit(1) }
  wallet = created.wallet
  const bank = created.bank

  // Conservation: balance + bank + pool = START
  const total1 = wallet.balance + bank + wallet.rewardPool
  check('After Hard create: balance + bank + pool = START', near(total1, START),
    `${wallet.balance.toFixed(3)} + ${bank.toFixed(3)} + ${wallet.rewardPool.toFixed(3)} = ${total1.toFixed(3)} ≠ ${START}`)

  // Hard entry
  const entered = settleHardEntry(wallet, 0, 1)
  if (!entered) { check('settleHardEntry returned result', false); process.exit(1) }
  wallet = entered.wallet
  const bank2 = bank + entered.bankAdd

  const total2 = wallet.balance + bank2 + wallet.rewardPool
  check('After Hard entry: balance + bank + pool = START', near(total2, START),
    `${total2.toFixed(3)} ≠ ${START}`)

  // Friend clears: bank → raider (95%) + pool (5%)
  const raiderPayout = bank2 * HARD.clearRaiderFrac
  const clearFee = bank2 * HARD.clearFeeFrac
  let walletAfterClear = credit(wallet, raiderPayout)
  walletAfterClear = applyProtocolFee(walletAfterClear, clearFee)
  const total3 = walletAfterClear.balance + 0 /* bank cleared */ + walletAfterClear.rewardPool
  check('After Friend clear: all money accounted for', near(total3, START),
    `${total3.toFixed(3)} ≠ ${START}`)
}

// ── Invariant 2: Claim tax at each win level ───────────────────────────────────

console.log('\n── Invariant 2: Claim tax correctness ───────────────────────────')

{
  const EXPECTED_TAX: Record<number, number> = {
    0: 0.95, 1: 0.95, 2: 0.90, 3: 0.80, 4: 0.70,
    5: 0.50, 6: 0.20, 7: 0.05, 8: 0, 9: 0, 15: 0,
  }
  for (const [winsStr, expectedTax] of Object.entries(EXPECTED_TAX)) {
    const wins = Number(winsStr)
    const tax = claimTaxFrac(wins)
    check(`claimTaxFrac(${wins}) = ${expectedTax}`, near(tax, expectedTax), `got ${tax}`)
  }

  // Specific: win 3 (80% tax)
  const wins = 3
  const bank = hardBankAfterKills(wins)
  const { ownerPayout, fee, taxed } = settleHardClaimWithTax(bank, wins)
  check('win 3: taxed = bank × 0.80', near(taxed, bank * 0.80), `${taxed.toFixed(3)} vs ${(bank * 0.80).toFixed(3)}`)
  check('win 3: ownerPayout = bank × 0.20 × 0.95', near(ownerPayout, bank * 0.20 * HARD.clearOwnerFrac),
    `${ownerPayout.toFixed(3)}`)
  check('win 3: ownerPayout + fee + taxed = bank', near(ownerPayout + fee + taxed, bank),
    `sum ${(ownerPayout + fee + taxed).toFixed(3)} ≠ ${bank.toFixed(3)}`)
}

// ── Invariant 3: Ticket mint schedule ─────────────────────────────────────────

console.log('\n── Invariant 3: Ticket mint schedule ────────────────────────────')

{
  check('wins 1–6: no tickets', [1, 2, 3, 4, 5, 6].every((w) => ticketMintAtWin(w) === 0))
  check('win 7: 1 ticket', ticketMintAtWin(7) === 1)
  check('win 8: 2 tickets', ticketMintAtWin(8) === 2)
  check('win 10: 3 tickets', ticketMintAtWin(10) === 3)
  check('win 25+: 64 tickets (cap)', ticketMintAtWin(25) === 64 && ticketMintAtWin(99) === 64)
  check('mint schedule is non-decreasing', (
    () => {
      let prev = 0
      for (let w = 7; w <= 25; w++) {
        const t = ticketMintAtWin(w)
        if (t < prev) return false
        prev = t
      }
      return true
    }
  )())
}

// ── Invariant 4: Early claim ticket slash ──────────────────────────────────────

console.log('\n── Invariant 4: Early claim ticket slash ─────────────────────────')

{
  // unlockWins = 8: claim at wins=7 → slash (keep 20%)
  const t7 = addTicketPower(createTicket('owner'), 'dg1', 100)
  const slashed7 = slashTicketsOnEarlyClaim(t7, 'dg1', 7)
  check('claim at wins=7: keep 20% (earlyClaimKeepFrac)', near(slashed7.power, 20),
    `power=${slashed7.power}`)
  check('claim at wins=7: byDungeon cleared', !slashed7.byDungeon['dg1'])

  // claim at wins=8 → no slash
  const t8 = addTicketPower(createTicket('owner'), 'dg1', 100)
  const notSlashed = slashTicketsOnEarlyClaim(t8, 'dg1', 8)
  check('claim at wins=8 (unlockWins): keep 100%', near(notSlashed.power, 100),
    `power=${notSlashed.power}`)

  // claim at wins=1 → keep 20%
  const t1 = addTicketPower(createTicket('owner'), 'dg1', 50)
  const slashed1 = slashTicketsOnEarlyClaim(t1, 'dg1', 1)
  check('claim at wins=1: keep 20%', near(slashed1.power, 10), `power=${slashed1.power}`)
}

// ── Invariant 5: Wipe ticket transfer (Friend clears dungeon) ─────────────────

console.log('\n── Invariant 5: Wipe ticket transfer ────────────────────────────')

{
  const ownerTicket = addTicketPower(createTicket('owner'), 'dg1', 100)
  const friendTicket = createTicket('friend')
  const { owner, friend, transferred, burned } = transferTicketsOnWipe(ownerTicket, friendTicket, 'dg1')

  check('wipe: owner loses all dg1 power', near(owner.power, 0), `owner.power=${owner.power}`)
  check('wipe: friend gains wipeToFriendFrac (90%)', near(friend.power, 90), `friend.power=${friend.power}`)
  check('wipe: burned = wipeBurnFrac (10%)', near(burned, 10), `burned=${burned}`)
  check('wipe: transferred + burned = original 100', near(transferred + burned, 100),
    `${transferred} + ${burned} = ${transferred + burned}`)
  check('wipe: byDungeon cleared on owner', !owner.byDungeon['dg1'])
}

// ── Invariant 6: Week-end settlement math ─────────────────────────────────────

console.log('\n── Invariant 6: Week-end settlement ─────────────────────────────')

{
  const pool$ = 1000
  const burned = pool$ * PROTOCOL_WEEKLY_BURN_FRAC
  const afterBurn = pool$ - burned
  const ticketPot = afterBurn * TICKET_POOL_FRAC
  const rollover = afterBurn - ticketPot

  check(`burn = pool × ${PROTOCOL_WEEKLY_BURN_FRAC} = ${burned}`, near(burned, 5), `${burned}`)
  check(`ticketPot = afterBurn × ${TICKET_POOL_FRAC} = ${ticketPot.toFixed(2)}`, near(ticketPot, 248.75))
  check(`rollover = afterBurn × 0.75 = ${rollover.toFixed(2)}`, near(rollover, 746.25))
  check('rollover + ticketPot = afterBurn', near(rollover + ticketPot, afterBurn))

  // Player with 100 tickets, AI with 400 → 500 total
  const playerPower = 100
  const aiPower = 400
  const totalPower = playerPower + aiPower
  const playerPayout = ticketPot * (playerPower / totalPower)

  check('player payout proportional (100/500 = 20%)', near(playerPayout, ticketPot * 0.2),
    `${playerPayout.toFixed(3)}`)
  check('player payout ≤ ticketPot', playerPayout <= ticketPot + 1e-9)
  check('player cannot get > 100% of ticket pot', playerPayout / ticketPot <= 1.0)

  // Verify pool balance after settlement
  // pool loses: burned + ticketPot (distributed to all players externally)
  // pool keeps: rollover
  check('new pool = rollover (75% of after-burn)', near(rollover, pool$ * 0.995 * 0.75),
    `${rollover.toFixed(3)} vs ${(pool$ * 0.995 * 0.75).toFixed(3)}`)
}

// ── Invariant 7: TICKET constants sanity ──────────────────────────────────────

console.log('\n── Invariant 7: TICKET constants sanity ─────────────────────────')

{
  check('earlyClaimKeepFrac = 0.2 (20%)', TICKET.earlyClaimKeepFrac === 0.2)
  check('wipeToFriendFrac + wipeBurnFrac = 1', near(TICKET.wipeToFriendFrac + TICKET.wipeBurnFrac, 1.0))
  check('unlockWins = 8', TICKET.unlockWins === 8)
  check('TICKET_POOL_FRAC = 0.25', TICKET_POOL_FRAC === 0.25)
  check('PROTOCOL_WEEKLY_BURN_FRAC = 0.005', PROTOCOL_WEEKLY_BURN_FRAC === 0.005)
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(55)}`)
console.log(`Results: ${passCount} PASS · ${failCount} FAIL`)
if (failCount === 0) {
  console.log('✅ All economy invariants pass!')
} else {
  console.log(`❌ ${failCount} invariant(s) failed — check economy.ts`)
  process.exit(1)
}
