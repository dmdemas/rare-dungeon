import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CreateDungeon } from './components/CreateDungeon'
import { Menu } from './components/Menu'
import { MyDungeons } from './components/MyDungeons'
import { OutcomeOverlay } from './components/OutcomeOverlay'
import { PlayerHistory } from './components/PlayerHistory'
import { PlaySelect } from './components/PlaySelect'
import { RaidView } from './components/RaidView'
import { WeekSettlementOverlay } from './components/WeekSettlementOverlay'
import {
  HARD,
  SOFT,
  TICKET,
  TICKET_POOL_FRAC,
  PROTOCOL_WEEKLY_BURN_FRAC,
  absoluteDungeonPowerScale,
  asHardDungeon,
  asSoftDungeon,
  applyProtocolFee,
  claimTaxFrac,
  createWallet,
  credit,
  entryMulFromPressure,
  hardPressureFromLive,
  hardSuggestedClose,
  quoteHardEntry,
  quoteSoftEntry,
  settleHardClaimWithTax,
  settleHardCreate,
  settleHardEntry,
  settleSoftClaim,
  ticketMintAtWin,
  settleSoftCreate,
  settleSoftEntry,
  softSuggestedClose,
  payHardOfferReroll,
  rerollCost,
  type DungeonTier,
  type WalletState,
} from './game/economy'
import { pickCreatePair } from './game/poolGen'
import { startRaid } from './game/raid'
import type { DungeonBlueprint, RaidState, Screen, SimWatchResult } from './game/types'
import {
  WORLD_STEP_MS,
  feedEvent,
  loadWorld,
  takeFromReserve,
  type FeedItem,
  type GameEvent,
} from './game/world'
import { playerEvent, type PlayerEvent, type PlayerEventInput } from './game/playerHistory'
import { applyRaidStep, type RaidStep } from './game/worldSim'
import { projectedTicketPayout } from './game/worldStats'
import { money } from './components/ui/format'
/** Week 1 opens on Saturday mid-day with ~5.5 days of AI fee flow in the pool. */
const START_POOL = 812.4
const START_WEEKDAY = 5
const START_BASELINE_DAILY = START_POOL / (START_WEEKDAY + 0.5)
/** Back-dating spacing of pre-window feed history. */
const HISTORY_SPACING_MS = 4 * 60_000

/**
 * AI ticket power: represents all AI players' ticket accumulation this week.
 * Calibrated to give real player a ~5–15% share of the ticket pot.
 * Grows slowly week over week as the AI pool matures.
 */
function initialAiTicketPower(weekNumber: number): number {
  return 500 + weekNumber * 40
}

export default function App() {
  /** Pre-simulated world: 50 Soft + 50 Hard with real raid history, reserve, replay log. */
  const [world] = useState(loadWorld)
  const [pool, setPool] = useState<DungeonBlueprint[]>(() => world.pool)
  /** Latest pool, also advanced synchronously by back-to-back simulated raids. */
  const poolRef = useRef(pool)
  poolRef.current = pool
  /** Refills the 50 when the player clears one. */
  const [reserve, setReserve] = useState(world.reserve)
  const [screen, setScreen] = useState<Screen>({ kind: 'menu' })
  const [activeBlueprint, setActiveBlueprint] = useState<DungeonBlueprint | null>(null)
  /** Entry $ paid for the active raid (Friend × display). */
  const [activeEntryPaid, setActiveEntryPaid] = useState(0)
  const [wallet, setWallet] = useState<WalletState>(() => ({
    // Start mid-week: $250 balance, pool already accumulated from AI activity this week
    ...createWallet(250),
    rewardPool: START_POOL,
  }))
  const [demoIntro, setDemoIntro] = useState(true)
  const [lastError, setLastError] = useState<string | null>(null)
  const [pendingTier, setPendingTier] = useState<DungeonTier>('soft')
  /** Bank / invested of the create fee already paid for the dungeon being set up. */
  const [createPaid, setCreatePaid] = useState<{ bank: number; invested: number } | null>(null)
  /** Ticket power earned as raider (clearing dungeons). Used in week-end pool split. */
  const [raiderTicketPower, setRaiderTicketPower] = useState(0)
  /** Current week number (starts at 1, increments each settlement). */
  const [weekNumber, setWeekNumber] = useState(1)
  /** AI players' combined ticket power this week. Resets each week. */
  const [aiTicketPower, setAiTicketPower] = useState(() => initialAiTicketPower(1))
  /** Everyone else's ticket power this week, estimated once for the session. */
  const [worldTickets] = useState(
    () => world.pool.reduce((s, d) => s + (d.isOwned ? 0 : d.ticketPower ?? 0), 0) + initialAiTicketPower(1),
  )
  /** World feed (ticker + activity panel): snapshot history, then replayed live items. */
  const [feed, setFeed] = useState<GameEvent[]>(() => {
    const now = Date.now()
    const hist = world.snapshot.history
    return hist.map((item, i) => feedEvent(item, now - (hist.length - i) * HISTORY_SPACING_MS))
  })
  /** Amount burned in the last completed week (for display). */
  const [lastWeekBurn, setLastWeekBurn] = useState(28.50)
  /** The player's own dungeons, raids and payouts (My Dungeons → History). */
  const [history, setHistory] = useState<PlayerEvent[]>([])
  /** Sequential dungeon creation counter (My Dungeon #1, #2, …). */
  const [dungeonSeq, setDungeonSeq] = useState(0)
  const logEvent = useCallback((e: PlayerEventInput) => setHistory((h) => [...h, playerEvent(e)]), [])
  const replayStepRef = useRef(0)
  const [nextTickAt, setNextTickAt] = useState(() => Date.now() + WORLD_STEP_MS)
  const [lastPoolAdd, setLastPoolAdd] = useState(0)
  /** "+$ → wallet" toast after a claim or a week payout. */
  const [creditFx, setCreditFx] = useState<{ id: number; amount: number; balance: number } | null>(null)
  useEffect(() => {
    if (!creditFx) return
    const t = window.setTimeout(() => setCreditFx(null), 2600)
    return () => window.clearTimeout(t)
  }, [creditFx])

  /** Generic bottom-right info pop-ups — shown ONLY when menu is visible. */
  type PopupMsg = { id: number; text: string; sub?: string; kind?: 'info' | 'win' }
  const [popups, setPopups] = useState<PopupMsg[]>([])
  /** Queue of popups to show once the user returns to the menu. */
  const pendingPopupsRef = useRef<Array<{ text: string; sub?: string; kind?: PopupMsg['kind'] }>>([])

  const showPopup = (text: string, sub?: string, kind: PopupMsg['kind'] = 'info') => {
    // Only show immediately if we're already on the menu screen; otherwise queue.
    if (screen.kind === 'menu') {
      const id = Date.now() + Math.random()
      setPopups((p) => [...p, { id, text, sub, kind }])
      window.setTimeout(() => setPopups((p) => p.filter((x) => x.id !== id)), 3200)
    } else {
      pendingPopupsRef.current = [...pendingPopupsRef.current, { text, sub, kind }]
    }
  }

  // ── World replay: one pre-simulated AI step per WORLD_STEP_MS (pool $, tickets, feed) ─
  useEffect(() => {
    const snap = world.snapshot
    const feedAt = new Map<number, FeedItem[]>()
    for (const { step, item } of snap.live) feedAt.set(step, [...(feedAt.get(step) ?? []), item])
    const timer = setInterval(() => {
      const step = replayStepRef.current
      replayStepRef.current = (step + 1) % snap.poolCents.length
      setNextTickAt(Date.now() + WORLD_STEP_MS)
      const poolAdd = (snap.poolCents[step] ?? 0) / 100
      setLastPoolAdd(poolAdd)
      if (poolAdd > 0) setWallet((w) => ({ ...w, rewardPool: w.rewardPool + poolAdd }))
      const dTickets = snap.tickets[step] ?? 0
      if (dTickets !== 0) setAiTicketPower((p) => Math.max(0, p + dTickets))
      const items = feedAt.get(step)
      if (items) setFeed((f) => [...f, ...items.map((it) => feedEvent(it))])
    }, WORLD_STEP_MS)
    return () => clearInterval(timer)
  }, [world])

  const owned = useMemo(() => pool.filter((d) => d.isOwned), [pool])
  const raidPool = useMemo(
    () =>
      pool.filter(
        (d) => !d.isOwned && d.status !== 'closed' && (d.tier ?? 'soft') === pendingTier,
      ),
    [pool, pendingTier],
  )
  const ownedLive = useMemo(() => owned.filter((d) => d.status !== 'closed'), [owned])
  const ownedTicketPower = useMemo(() => owned.reduce((s, d) => s + (d.ticketPower ?? 0), 0), [owned])

  const liveSoft = useMemo(
    () => pool.filter((d) => (d.tier ?? 'soft') === 'soft' && d.status !== 'closed').length,
    [pool],
  )
  const liveHard = useMemo(
    () => pool.filter((d) => d.tier === 'hard' && d.status !== 'closed').length,
    [pool],
  )

  /** Soft entry stays at parity (mul=1). Hard uses Soft/Hard live pressure proxy. */
  const softEntryQuote = useMemo(() => quoteSoftEntry(1), [])
  const hardEntryMul = useMemo(
    () => entryMulFromPressure(hardPressureFromLive(liveSoft, liveHard)),
    [liveSoft, liveHard],
  )
  const hardEntryQuote = useMemo(() => quoteHardEntry(hardEntryMul), [hardEntryMul])

  /** Track which dungeon IDs we've already notified about reaching their claim target. */
  const notifiedPausedRef = useRef<Set<string>>(new Set())

  const flushPendingPopups = useCallback((extraItems: typeof pendingPopupsRef.current = []) => {
    const pending = [...pendingPopupsRef.current, ...extraItems]
    pendingPopupsRef.current = []
    if (pending.length === 0) return
    // Show each queued popup with a staggered delay
    let delay = 200
    for (const p of pending) {
      const captured = { ...p }
      window.setTimeout(() => {
        const id = Date.now() + Math.random()
        setPopups((prev) => [...prev, { id, ...captured }])
        window.setTimeout(() => setPopups((prev) => prev.filter((x) => x.id !== id)), 3200)
      }, delay)
      delay += 800
    }
  }, [setPopups])

  const goMenu = useCallback(() => {
    setLastError(null)
    setScreen({ kind: 'menu' })
    // Check for dungeons that reached their planned close target.
    const pausedNotices: typeof pendingPopupsRef.current = []
    for (const d of poolRef.current) {
      if (
        d.isOwned &&
        d.status !== 'closed' &&
        d.closeAtWins != null &&
        (d.wins ?? 0) >= d.closeAtWins &&
        !notifiedPausedRef.current.has(d.id)
      ) {
        notifiedPausedRef.current.add(d.id)
        pausedNotices.push({ text: `${d.name} READY TO CLAIM`, sub: `Level ${d.wins} · planned target reached`, kind: 'win' })
      }
    }
    flushPendingPopups(pausedNotices)
  }, [flushPendingPopups])

  const openPlay = (tier: DungeonTier) => {
    setPendingTier(tier)
    setScreen({ kind: 'play' })
  }

  const openCreate = (tier: DungeonTier) => {
    if (ownedLive.length >= 3) {
      setLastError('Max 3 live dungeons.')
      return
    }
    // Fee is charged immediately when entering create mode
    const settled = tier === 'hard' ? settleHardCreate(wallet, 0) : settleSoftCreate(wallet)
    if (!settled) {
      const cost = tier === 'hard' ? HARD.createCost : SOFT.createCost
      setLastError(`Need $${cost} to create ${tier}.`)
      return
    }
    setWallet(settled.wallet)
    setCreatePaid({ bank: settled.bank, invested: settled.invested })
    setPendingTier(tier)
    const [a, b] = pickCreatePair(tier)
    const wrap = tier === 'hard' ? asHardDungeon : asSoftDungeon
    setScreen({
      kind: 'create',
      options: [wrap(a, { name: 'Layout A' }), wrap(b, { name: 'Layout B' })],
    })
  }

  /** No-op — fee is now charged upfront in openCreate. */
  const payCreate = (): boolean => true

  /** Live raid state for the sim-watch screen (updated by RaidView via onRaidChange). */
  const [simWatchRaid, setSimWatchRaid] = useState<RaidState | null>(null)
  /** Result of the last sim-watch raid, waiting for the user to press Next. */
  const [simWatchPending, setSimWatchPending] = useState<SimWatchResult | null>(null)

  /** Forced perk sequence for the current sim-watch raid (ensures visual replay matches headless). */
  const [simWatchPerkSeq, setSimWatchPerkSeq] = useState<string[] | undefined>(undefined)

  /** Open bot-mode visual simulation for an owned dungeon, optionally replaying a specific raid. */
  const startSimWatch = (bp: DungeonBlueprint, friendPickSequence?: string[], raidSeed?: number) => {
    setActiveBlueprint(bp)
    setSimWatchRaid(startRaid(bp, 1, raidSeed))
    setSimWatchPending(null)
    setSimWatchPerkSeq(friendPickSequence)
    setScreen({ kind: 'simWatch', blueprint: bp, raidIndex: 1, results: [] })
  }

  const onSimWatchRaidChange = useCallback((r: RaidState) => setSimWatchRaid(r), [])

  /** Called when a sim-watch raid ends: show result card. */
  const onSimWatchOutcome = useCallback(
    (result: 'won' | 'dead' | 'surrendered', floor: number) => {
      setScreen((prev) => {
        if (prev.kind !== 'simWatch') return prev
        const entry: SimWatchResult = { index: prev.raidIndex, won: result === 'won', floor }
        setSimWatchPending(entry)
        return { ...prev, results: [...prev.results, entry] }
      })
    },
    [],
  )

  /** Close sim-watch and return to My Dungeons. */
  const closeSimWatch = useCallback(() => {
    setSimWatchPending(null)
    setActiveBlueprint(null)
    setSimWatchRaid(null)
    setScreen({ kind: 'myDungeons' })
  }, [])


  const pickCreated = (bp: DungeonBlueprint) => {
    const tier = bp.tier ?? pendingTier
    const settled = createPaid
    setCreatePaid(null)
    if (!settled) {
      setScreen({ kind: 'menu' })
      return
    }
    const seq = dungeonSeq + 1
    setDungeonSeq(seq)
    const dungeonName = `My Dungeon #${seq}`

    if (tier === 'hard') {
      const ownedBp: DungeonBlueprint = {
        ...asHardDungeon(bp, { owned: true }),
        dungeonPerks: bp.dungeonPerks,
        perkPitKeys: bp.perkPitKeys,
        map: bp.map,
        mobSpawns: bp.mobSpawns,
        bank: settled.bank,
        invested: settled.invested,
        name: dungeonName,
      }
      setPool((p) => [...p, ownedBp])
      logEvent({ kind: 'created', tier: 'hard', name: dungeonName, cost: HARD.createCost })
      showPopup('+1 DUNGEON', 'Added to My Dungeons')
    } else {
      const ownedBp: DungeonBlueprint = {
        ...asSoftDungeon(bp, { owned: true }),
        dungeonPerks: bp.dungeonPerks,
        perkPitKeys: bp.perkPitKeys,
        map: bp.map,
        mobSpawns: bp.mobSpawns,
        bank: settled.bank,
        invested: settled.invested,
        name: dungeonName,
      }
      setPool((p) => [...p, ownedBp])
      logEvent({ kind: 'created', tier: 'soft', name: dungeonName, cost: SOFT.createCost })
      showPopup('+1 DUNGEON', 'Added to My Dungeons')
    }
    setLastError(null)
    goMenu()
  }

  const startPlay = (bp: DungeonBlueprint) => {
    if (bp.isOwned) return
    const tier = bp.tier ?? 'soft'
    if (tier === 'hard') {
      const settled = settleHardEntry(wallet, 0, hardEntryMul)
      if (!settled) {
        setLastError(`Need $${hardEntryQuote.cost.toFixed(2)} to raid Hard.`)
        return
      }
      setWallet(settled.wallet)
      const withBank: DungeonBlueprint = {
        ...bp,
        tier: 'hard',
        dungeonPowerScale: bp.dungeonPowerScale ?? absoluteDungeonPowerScale('hard'),
        bank: (bp.bank ?? HARD.createToBank) + settled.bankAdd,
        wins: bp.wins ?? 0,
      }
      setPool((p) => p.map((d) => (d.id === bp.id ? withBank : d)))
      setActiveBlueprint(withBank)
      setActiveEntryPaid(settled.quote.cost)
      setLastError(null)
      setScreen({ kind: 'raid', raid: startRaid(withBank) })
      return
    }

    const settled = settleSoftEntry(wallet, softEntryQuote.mul)
    if (!settled) {
      setLastError(`Need $${softEntryQuote.cost.toFixed(2)} to raid Soft.`)
      return
    }
    setWallet(settled.wallet)
    const withBank: DungeonBlueprint = {
      ...bp,
      tier: 'soft',
      dungeonPowerScale: bp.dungeonPowerScale ?? absoluteDungeonPowerScale('soft'),
      bank: (bp.bank ?? SOFT.createToBank) + settled.bankAdd,
      wins: bp.wins ?? 0,
    }
    setPool((p) => p.map((d) => (d.id === bp.id ? withBank : d)))
    setActiveBlueprint(withBank)
    setActiveEntryPaid(settled.quote.cost)
    setLastError(null)
    setScreen({ kind: 'raid', raid: startRaid(withBank) })
  }

  const onRaidChange = useCallback((raid: RaidState) => {
    setScreen({ kind: 'raid', raid })
  }, [])

  const onOutcome = useCallback(
    (result: 'won' | 'dead' | 'surrendered', floor: number) => {
      const bp = activeBlueprint
      const name = bp?.name ?? 'Dungeon'
      if (!bp) {
        setScreen({ kind: 'outcome', result, dungeonName: name, floor })
        return
      }
      const tier = bp.tier ?? 'soft'
      const cfg = tier === 'hard' ? HARD : SOFT

      if (result === 'won') {
        const bank = bp.bank ?? cfg.createToBank
        const raiderPayout = bank * cfg.clearRaiderFrac
        const fee = bank * cfg.clearFeeFrac
        const entryPaid = activeEntryPaid > 0 ? activeEntryPaid : cfg.entryCost
        const raiderTickets = tier === 'hard' ? (bp.ticketPower ?? 0) * TICKET.wipeToFriendFrac : 0
        if (raiderTickets > 0) setRaiderTicketPower((p) => p + raiderTickets)
        setWallet((w) => applyProtocolFee(credit(w, raiderPayout), fee))
        showPopup(`+${money(raiderPayout)}`, 'Added to wallet', 'win')
        const refill = takeFromReserve(reserve, tier)
        setReserve(refill.reserve)
        setPool((p) => [...p.filter((d) => d.id !== bp.id), refill.bp])
        logEvent({ kind: 'raidWon', tier, name, payout: raiderPayout, paid: entryPaid, tickets: raiderTickets })
        setScreen({
          kind: 'outcome',
          result,
          dungeonName: name,
          floor,
          payout: raiderPayout,
          entryPaid,
          tickets: raiderTickets,
          ticketBalance: ownedTicketPower + raiderTicketPower + raiderTickets,
          note: `Took the ${tier} bank (${cfg.clearRaiderFrac * 100}% after fee).`,
        })
        return
      }

      logEvent({
        kind: 'raidLost',
        tier,
        name,
        paid: activeEntryPaid > 0 ? activeEntryPaid : cfg.entryCost,
        floor,
      })

      const wins = (bp.wins ?? 0) + 1
      const bank = bp.bank ?? cfg.createToBank
      // Mint tickets for Hard dungeons when they defeat a raider
      const newTickets = tier === 'hard' ? ticketMintAtWin(wins) : 0
      setPool((p) =>
        p.map((d) =>
          d.id === bp.id
            ? {
                ...d,
                bank,
                wins,
                rewardPending: bank,
                ticketPower: (d.ticketPower ?? 0) + newTickets,
              }
            : d,
        ),
      )
      setScreen({
        kind: 'outcome',
        result: result === 'surrendered' ? 'surrendered' : 'dead',
        dungeonName: name,
        floor,
        note: `Entry stayed in bank ($${bank.toFixed(2)}, ${wins} wins).`,
      })
    },
    [activeBlueprint, activeEntryPaid, reserve, logEvent, ownedTicketPower, raiderTicketPower],
  )

  /** One simulated AI raid on an owned dungeon (My Dungeons → simulate raids). */
  const onOwnedRaidStep = (id: string, step: RaidStep) => {
    const bp = poolRef.current.find((d) => d.id === id)
    if (!bp || bp.status === 'closed') return
    poolRef.current = poolRef.current.map((d) => (d.id === id ? applyRaidStep(d, step) : d))
    const tickets = bp?.ticketPower ?? 0
    if (step.wiped && tickets > 0) setAiTicketPower((a) => a + tickets * TICKET.wipeToFriendFrac)
    if (bp) {
      const tier = bp.tier ?? 'soft'
      logEvent(
        step.wiped
          ? {
              kind: 'robbed',
              tier,
              name: bp.name,
              invested: bp.invested ?? 0,
              wins: bp.wins ?? 0,
              raiderTook: step.payout,
              ticketsLost: tickets,
            }
          : {
              kind: 'defended',
              tier,
              name: bp.name,
              bankAdd: step.bankAfter - (bp.bank ?? 0),
              bankAfter: step.bankAfter,
              winsAfter: step.winsAfter,
              ticketsMinted: step.ticketsMinted,
            },
      )
    }
    setWallet((w) => ({ ...w, rewardPool: w.rewardPool + step.poolAdd }))
    setPool((p) => p.map((d) => (d.id === id ? applyRaidStep(d, step) : d)))
  }

  /** Move a paused dungeon's stop point `raids` further so it takes raids again. */
  const onExtend = (id: string, raids: number) => {
    const bp = poolRef.current.find((d) => d.id === id)
    if (!bp || !bp.isOwned || bp.status === 'closed' || raids <= 0) return
    const closeAtWins = Math.max(bp.closeAtWins ?? 0, bp.wins ?? 0) + raids
    poolRef.current = poolRef.current.map((d) => (d.id === id ? { ...d, closeAtWins } : d))
    setPool((p) => p.map((d) => (d.id === id ? { ...d, closeAtWins } : d)))
  }

  /** $ these tickets would take from the reward pool if the week ended now. */
  const ticketUsd = (tickets: number) => projectedTicketPayout(wallet.rewardPool, tickets, worldTickets).payout

  const showCredit = (amount: number) => {
    if (amount <= 0) return
    setCreditFx({ id: Date.now(), amount, balance: wallet.balance + amount })
  }

  const onClaim = (id: string) => {
    const bp = poolRef.current.find((d) => d.id === id)
    if (!bp || !bp.isOwned || bp.status === 'closed') return
    const tier = bp.tier ?? 'soft'
    const cfg = tier === 'hard' ? HARD : SOFT
    const wins = bp.wins ?? 0
    if (tier === 'soft' && wins < cfg.minWinsBeforeClaim) {
      setLastError(`Need ${cfg.minWinsBeforeClaim} wins to close.`)
      return
    }
    poolRef.current = poolRef.current.map((d) => (d.id === id ? { ...d, status: 'closed' } : d))
    const bank = bp.bank ?? cfg.createToBank
    const shares = bp.sharesAccrued ?? 0

    if (tier === 'hard') {
      const { ownerPayout, fee, taxed } = settleHardClaimWithTax(bank, wins)
      const total = ownerPayout + shares
      // tax + fee both go to the pool (reward pool)
      setWallet((w) => {
        let next = credit(w, total)
        next = applyProtocolFee(next, fee + taxed)
        return next
      })
      const invested0 = bp.invested ?? cfg.createCost
      const roi0 = invested0 > 0 ? total / invested0 : 1
      showPopup(`DUNGEON CLOSED · ${roi0.toFixed(2)}×`, `+${money(total)} to wallet`, 'win')
      // Early claim ticket slash: wins < unlockWins (8) → keep only 20% of ticket power.
      // The burned 80% simply disappears (economic penalty for impatience).
      const rawTicketPower = bp.ticketPower ?? 0
      const slashedTicketPower =
        wins < TICKET.unlockWins
          ? Math.floor(rawTicketPower * TICKET.earlyClaimKeepFrac)
          : rawTicketPower
      logEvent({
        kind: 'closed',
        tier,
        name: bp.name,
        payout: total,
        invested: bp.invested ?? cfg.createCost,
        taxPct: Math.round(claimTaxFrac(wins) * 100),
        wins,
        ticketsKept: slashedTicketPower,
      })
      setPool((p) =>
        p.map((d) =>
          d.id === id
            ? {
                ...d,
                status: 'closed',
                withdrawn: (d.withdrawn ?? 0) + total,
                bank: 0,
                sharesAccrued: 0,
                rewardPending: 0,
                // ticketPower (slashed if early) stays until week-end settlement
                ticketPower: slashedTicketPower,
              }
            : d,
        ),
      )
    } else {
      const settled = settleSoftClaim(bank, wins)
      const ownerPayout = settled.ownerPayout + shares
      logEvent({
        kind: 'closed',
        tier,
        name: bp.name,
        payout: ownerPayout,
        invested: bp.invested ?? cfg.createCost,
        taxPct: 0,
        wins,
        ticketsKept: 0,
      })
      setWallet((w) => applyProtocolFee(credit(w, ownerPayout), settled.fee))
      const invested1 = bp.invested ?? cfg.createCost
      const roi1 = invested1 > 0 ? ownerPayout / invested1 : 1
      showPopup(`DUNGEON CLOSED · ${roi1.toFixed(2)}×`, `+${money(ownerPayout)} to wallet`, 'win')
      setPool((p) =>
        p.map((d) =>
          d.id === id
            ? {
                ...d,
                status: 'closed',
                withdrawn: (d.withdrawn ?? 0) + ownerPayout,
                bank: 0,
                sharesAccrued: 0,
                rewardPending: 0,
              }
            : d,
        ),
      )
    }
    setLastError(null)
  }

  /**
   * Week-end settlement.
   *
   * Pool math:
   *   1. Burn 0.5% (PROTOCOL_WEEKLY_BURN_FRAC) → wallet.burned
   *   2. Of the remaining 99.5%:
   *      - 25% (TICKET_POOL_FRAC) → ticket pot, divided pro-rata among ALL ticket holders
   *        (real player + AI players). Calibrated so win-25 jackpot ≈ 30× vs win-7 ≈ 3.7×.
   *      - 75% → rollover to next week (stays in rewardPool)
   *   3. Real player receives their share of the ticket pot.
   *
   * AI ticket power (aiTicketPower) represents ~1000 AI sessions this week.
   * The AI's share of the pot is simply removed from the pool (paid to off-screen players).
   */
  const onSettleWeek = () => {
    const pool$ = wallet.rewardPool
    if (pool$ <= 0) {
      // Nothing to settle — still start next week
      const newWeek = weekNumber + 1
      setWeekNumber(newWeek)
      setAiTicketPower(initialAiTicketPower(newWeek))
      setScreen({
        kind: 'weekSettled',
        weekNumber,
        ticketPayout: 0,
        playerPower: 0,
        totalPower: 0,
        burned: 0,
        rollover: 0,
      })
      return
    }

    // Step 1: Burn
    const burned = pool$ * PROTOCOL_WEEKLY_BURN_FRAC
    const afterBurn = pool$ - burned

    // Step 2: Split
    const ticketPot = afterBurn * TICKET_POOL_FRAC
    const rollover = afterBurn - ticketPot // 75% stays

    // Step 3: Pro-rata share for real player
    const ownedTickets = pool
      .filter((d) => d.isOwned)
      .reduce((s, d) => s + (d.ticketPower ?? 0), 0)
    const playerPower = ownedTickets + raiderTicketPower
    const totalPower = playerPower + aiTicketPower
    const playerPayout = totalPower > 0 ? (ticketPot * playerPower) / totalPower : 0

    // Step 4: Apply
    // AI's share (ticketPot - playerPayout) leaves the pool silently (paid to AI players).
    // Net pool after: rollover (75% of afterBurn).
    setWallet((w) => {
      const next: WalletState = {
        ...w,
        rewardPool: rollover,
        balance: w.balance + playerPayout,
        burned: w.burned + burned,
      }
      return next
    })

    showCredit(playerPayout)
    if (playerPower > 0) {
      logEvent({ kind: 'weekPaid', tier: 'hard', name: `Week ${weekNumber}`, week: weekNumber, payout: playerPayout, tickets: playerPower })
    }

    // Reset ticket power
    setPool((p) => p.map((d) => (d.isOwned ? { ...d, ticketPower: 0 } : d)))
    setRaiderTicketPower(0)

    // Advance week
    setLastWeekBurn(burned)
    const newWeek = weekNumber + 1
    setWeekNumber(newWeek)
    setAiTicketPower(initialAiTicketPower(newWeek))

    setScreen({
      kind: 'weekSettled',
      weekNumber,
      ticketPayout: playerPayout,
      playerPower,
      totalPower,
      burned,
      rollover,
    })
  }

  return (
    <div className={screen.kind === 'menu' ? 'app app--menu' : 'app'}>
      {screen.kind === 'menu' && (
        <Menu
          wallet={wallet}
          weekNumber={weekNumber}
          lastWeekBurn={lastWeekBurn}
          error={lastError}
          softEntryCost={softEntryQuote.cost}
          hardEntryCost={hardEntryQuote.cost}
          hardEntryMul={hardEntryMul}
          worldPool={pool}
          owned={owned}
          nextTickAt={nextTickAt}
          lastPoolAdd={lastPoolAdd}
          playerTickets={ownedTicketPower + raiderTicketPower}
          ticketUsd={ticketUsd}
          weekday={weekNumber === 1 ? START_WEEKDAY : 0}
          baselineDaily={START_BASELINE_DAILY}
          poolCents={world.snapshot.poolCents}
          history={history}
          onHistory={() => setScreen({ kind: 'history', from: 'menu' })}
          aiTickets={aiTicketPower}
          feed={feed}
          onPlay={openPlay}
          onCreate={openCreate}
          onMyDungeons={() => setScreen({ kind: 'myDungeons' })}
          onSettleWeek={onSettleWeek}
        />
      )}

      {screen.kind === 'create' && (
        <CreateDungeon
          options={screen.options}
          createCost={pendingTier === 'hard' ? HARD.createCost : SOFT.createCost}
          onPay={payCreate}
          onPick={pickCreated}
          ticketUsd={ticketUsd}
          onBack={() => {
            setCreatePaid(null)
            goMenu()
          }}
          offerReroll={
            (screen.options[0]?.tier ?? pendingTier) === 'hard'
              ? {
                  walletBalance: wallet.balance,
                  nextCost: rerollCost,
                  tryPay: (already) => {
                    const paid = payHardOfferReroll(wallet, already)
                    if (!paid) {
                      setLastError(`Need $${rerollCost(already).toFixed(2)} to reroll.`)
                      return false
                    }
                    setWallet(paid.wallet)
                    return true
                  },
                }
              : null
          }
        />
      )}

      {screen.kind === 'play' && (
        <PlaySelect
          pool={raidPool}
          onSelect={startPlay}
          onBack={goMenu}
        />
      )}

      {(screen.kind === 'myDungeons' || screen.kind === 'simWatch') && (
        <MyDungeons
          owned={owned}
          raiderTickets={raiderTicketPower}
          historyCount={history.length}
          onHistory={() => setScreen({ kind: 'history', from: 'myDungeons' })}
          walletBalance={wallet.balance}
          ticketUsd={ticketUsd}
          onClaim={onClaim}
          onExtend={onExtend}
          onRaidStep={onOwnedRaidStep}
          onBack={goMenu}
          softEntryQuote={softEntryQuote}
          hardEntryQuote={hardEntryQuote}
          liveSoft={liveSoft}
          liveHard={liveHard}
          onWatchSim={(bp, seq, seed) => startSimWatch(bp, seq, seed)}
          suggestClose={(bp) => {
            const tier = bp.tier ?? 'soft'
            if (tier === 'hard') {
              return hardSuggestedClose(
                bp.bank ?? HARD.createToBank,
                bp.wins ?? 0,
                HARD.suggestedCloseRoi,
              )
            }
            return softSuggestedClose(
              bp.bank ?? SOFT.createToBank,
              bp.wins ?? 0,
              SOFT.suggestedCloseRoi,
            )
          }}
        />
      )}

      {screen.kind === 'history' && (
        <PlayerHistory
          events={history}
          backLabel={screen.from === 'menu' ? 'Menu' : 'My dungeons'}
          onBack={() => setScreen(screen.from === 'menu' ? { kind: 'menu' } : { kind: 'myDungeons' })}
        />
      )}

      {screen.kind === 'raid' && activeBlueprint && (
        <RaidView
          raid={screen.raid}
          blueprint={activeBlueprint}
          entryPaid={activeEntryPaid}
          ticketUsd={ticketUsd}
          onRaidChange={onRaidChange}
          onOutcome={onOutcome}
          offerReroll={
            (activeBlueprint.tier ?? 'soft') === 'hard'
              ? {
                  walletBalance: wallet.balance,
                  nextCost: rerollCost,
                  tryPay: (already) => {
                    const paid = payHardOfferReroll(wallet, already)
                    if (!paid) {
                      setLastError(`Need $${rerollCost(already).toFixed(2)} to reroll.`)
                      return false
                    }
                    setWallet(paid.wallet)
                    return true
                  },
                }
              : null
          }
        />
      )}

      {screen.kind === 'simWatch' && activeBlueprint && simWatchRaid && (
        <>
          {/* Windowed RaidView — bot auto-picks perks, character moves */}
          <RaidView
            key={screen.raidIndex}
            raid={simWatchRaid}
            blueprint={activeBlueprint}
            onRaidChange={onSimWatchRaidChange}
            onOutcome={onSimWatchOutcome}
            onBack={closeSimWatch}
            forcedPerkSequence={simWatchPerkSeq as any}
            botMode
            windowed
          />

          {/* Result card shown after raid ends */}
          {simWatchPending && (
            <div className="sim-watch-result-overlay">
              <div className="card sim-watch-result-card">
                <div className={`sim-watch-result-title ${simWatchPending.won ? 'txt-win' : 'txt-loss'}`}>
                  {simWatchPending.won ? '✓ CLEARED' : `✗ DIED — FLOOR ${simWatchPending.floor}`}
                </div>
                <p className="card-sub">
                  {simWatchPending.won
                    ? 'The raider cleared all floors and robbed the dungeon.'
                    : `The raider died on floor ${simWatchPending.floor} — entry stays in the bank.`}
                </p>
                <button type="button" className="ghost" onClick={closeSimWatch}>
                  ← Back
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {screen.kind === 'outcome' && (
        <OutcomeOverlay
          result={screen.result}
          dungeonName={screen.dungeonName}
          floor={screen.floor}
          payout={screen.payout}
          entryPaid={screen.entryPaid}
          tickets={screen.tickets}
          ticketBalance={screen.ticketBalance}
          note={screen.note}
          onMenu={goMenu}
        />
      )}

      {screen.kind === 'weekSettled' && (
        <WeekSettlementOverlay
          weekNumber={screen.weekNumber}
          ticketPayout={screen.ticketPayout}
          playerPower={screen.playerPower}
          totalPower={screen.totalPower}
          burned={screen.burned}
          rollover={screen.rollover}
          onContinue={goMenu}
        />
      )}

      {demoIntro && (
        <div className="demo-intro" role="dialog" aria-labelledby="demo-intro-title">
          <div className="card demo-intro-card">
            <h1 id="demo-intro-title" className="action-title">WELCOME TO THE DEMO</h1>
            <div className="demo-intro-body">
              <p>Hello, visitors of this demo.</p>
              <p>
                You are dropping into a simulation of the game, late in the week. A script plays out player
                behavior as realistically as we can. In My Dungeons, <strong>SIMULATE RAIDS</strong> runs those
                raids.
              </p>
              <p>
                Open <strong>HOW TO PLAY</strong> first. Then <strong>ECONOMY</strong> — it opens a canvas that
                explains the whole economy.
              </p>
              <p>
                Numbers are in dollars so they are easy to read. In the real game everything settles in{' '}
                <strong>Rare Friends</strong> tokens.
              </p>
              <p className="demo-intro-signoff">
                Have fun, and good luck!
                <span className="demo-intro-sign">@0xCephal</span>
              </p>
            </div>
            <button type="button" className="connect demo-intro-enter" onClick={() => setDemoIntro(false)}>
              ENTER DEMO →
            </button>
          </div>
        </div>
      )}

      {creditFx && (
        <div key={creditFx.id} className="credit-toast" role="status">
          <span className="credit-toast-amount">+${creditFx.amount.toFixed(2)}</span>
          <span className="credit-toast-to">→ INTERNAL WALLET ${creditFx.balance.toFixed(2)}</span>
        </div>
      )}
      <div className="popup-stack" aria-live="polite">
        {popups.map((p) => (
          <div key={p.id} className={`popup-msg popup-msg--${p.kind ?? 'info'}`}
            onAnimationEnd={(e) => {
              // When the popup fully fades out, flash the wallet balance
              if (e.animationName === 'popup-in' && p.kind === 'win') {
                const el = document.querySelector<HTMLElement>('.wallet-amount')
                if (el) {
                  el.classList.remove('wallet-amount--flash')
                  void el.offsetWidth // reflow
                  el.classList.add('wallet-amount--flash')
                }
              }
            }}
          >
            <span className="popup-msg-text">{p.text}</span>
            {p.sub && <span className="popup-msg-sub">{p.sub}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
