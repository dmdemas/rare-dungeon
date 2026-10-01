import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  HARD,
  SOFT,
  claimTaxFrac,
  projectYieldAfterRaids,
  ticketMintAtWin,
  type EntryQuote,
} from '../game/economy'
import {
  createEmptyPerksState,
  createEmptySideState,
  syncRaidWithPerks,
  type DungeonPerkId,
  type PerkRank,
  type PerkSlotHistory,
  type SidePerkState,
} from '../game/perks'
import { startRaid } from '../game/raid'
import { mulberry32 } from '../game/rng'
import type { DungeonBlueprint } from '../game/types'
import { applyRaidStep, runEconomyRaid, type RaidStep } from '../game/worldSim'
import { closeNowPayout } from '../game/worldStats'
import { YieldDash } from './ClosePlan'
import { DungeonCanvas } from './DungeonCanvas'
import { MapPreview } from './MapPreview'
import { PerkSlotsBar } from './perks/PerkSlotsBar'
import { LEVEL_HINT } from './RewardDashboard'
import { PixelIcon } from './ui/PixelIcon'
import { money, tix } from './ui/format'

type Props = {
  owned: DungeonBlueprint[]
  /** Ticket power won as a raider this week (counted with dungeon tickets). */
  raiderTickets: number
  historyCount: number
  walletBalance: number
  ticketUsd: (tickets: number) => number
  onHistory: () => void
  onClaim: (id: string) => void
  /** Push a paused dungeon's stop point this many raids further. */
  onExtend: (id: string, raids: number) => void
  /** Apply one simulated AI raid to an owned dungeon. */
  onRaidStep: (id: string, step: RaidStep) => void
  onBack: () => void
  suggestClose?: (bp: DungeonBlueprint) => boolean
  softEntryQuote: EntryQuote
  hardEntryQuote: EntryQuote
  liveSoft: number
  liveHard: number
  /** Open visual bot-mode simulation for this dungeon. */
  onWatchSim?: (bp: DungeonBlueprint, friendPickSequence?: string[], raidSeed?: number) => void
}

function perksFromBlueprint(bp: DungeonBlueprint): SidePerkState<DungeonPerkId> {
  const raw = bp.dungeonPerks
  if (!raw) return createEmptySideState()
  return {
    slots: raw.slots as PerkSlotHistory<DungeonPerkId>,
    ranks: raw.ranks as Partial<Record<DungeonPerkId, PerkRank>>,
  }
}

const SIM_MAX_RAIDS = 20
const SIM_STEP_MS = 450
/** A dungeon's stop point can never go past this many survived raids. */
const MAX_RAIDS = 25

/** Owner payout and ticket power if the dungeon survives `extra` more raids. */
function projectAfter(bp: DungeonBlueprint, extra: number, quote: EntryQuote) {
  const tier = bp.tier ?? 'soft'
  const cfg = tier === 'hard' ? HARD : SOFT
  const wins = bp.wins ?? 0
  const p = projectYieldAfterRaids(tier, {
    bank: bp.bank ?? cfg.createToBank,
    wins,
    shares: bp.sharesAccrued ?? 0,
    invested: bp.invested ?? cfg.createCost,
    extraRaids: extra,
    entryQuote: quote,
  })
  let tickets = bp.ticketPower ?? 0
  if (tier === 'hard') for (let w = wins + 1; w <= wins + extra; w++) tickets += ticketMintAtWin(w)
  return { payout: p.ownerPayout, wins: p.wins, tickets, tax: tier === 'hard' ? claimTaxFrac(p.wins) : 0 }
}

/** Reached its close plan: takes no raids until the owner claims or extends. */
function isPaused(bp: DungeonBlueprint): boolean {
  return bp.status !== 'closed' && bp.closeAtWins != null && (bp.wins ?? 0) >= bp.closeAtWins
}

type RaidSim = {
  id: string
  name: string
  invested: number
  /** Raids announced; fewer run if the dungeon is wiped early. */
  planned: number
  steps: RaidStep[]
  shown: number
  /** Why the run ended before `planned` without a wipe. */
  end?: 'autoClose' | 'claimed'
}

/**
 * Real headless raids on the owned layout + baked perks. With a close plan it runs straight
 * to the planned level (or a wipe); without one it runs a random batch.
 */
function planRaidSim(bp: DungeonBlueprint): RaidSim {
  const rng = mulberry32((Math.random() * 0x100000000) >>> 0)
  const toPlan = bp.closeAtWins != null ? bp.closeAtWins - (bp.wins ?? 0) : 0
  // Run until wipe or SIM_MAX_RAIDS so we can show the dungeon's full lifespan
  const planned = toPlan > 0 ? toPlan : SIM_MAX_RAIDS
  const steps: RaidStep[] = []
  let end: RaidSim['end']
  let cur = bp
  for (let i = 0; i < planned; i++) {
    const step = runEconomyRaid(cur, rng)
    steps.push(step)
    if (step.wiped) break
    if (bp.closeAtWins != null && step.winsAfter >= bp.closeAtWins) {
      end = 'autoClose'
      break
    }
    cur = applyRaidStep(cur, step)
  }
  return {
    id: bp.id,
    name: bp.name,
    invested: bp.invested ?? 0,
    planned,
    steps,
    shown: 0,
    end,
  }
}

function raidLine(step: RaidStep, i: number): string {
  if (step.wiped) {
    return `Raid ${i + 1}: the raider cleared every floor and took $${step.payout.toFixed(2)} — dungeon robbed`
  }
  const mint = step.ticketsMinted > 0 ? `, +${tix(step.ticketsMinted)} tickets` : ''
  return `Raid ${i + 1}: the raider died on floor ${step.floor} → bank $${step.bankAfter.toFixed(2)}, ${step.winsAfter} wins${mint}`
}

function RaidSimPanel({
  sim,
  onClose,
  onWatch,
}: {
  sim: RaidSim
  onClose: () => void
  onWatch?: (step: RaidStep) => void
}) {
  const done = sim.shown >= sim.steps.length
  const wiped = sim.steps[sim.steps.length - 1]?.wiped ?? false

  // Last 3 raids to show as cards when done
  const last3 = sim.steps.slice(-3)
  const last3Start = Math.max(0, sim.steps.length - 3)

  return (
    <section className="card raid-sim">
      <h2 className="section-title">
        SIMULATION — {sim.name}
      </h2>

      {/* Running progress */}
      {!done && (
        <ul className="raid-sim-log">
          {sim.steps.slice(0, sim.shown).map((s, i) => (
            <li key={i} className={`raid-sim-entry ${s.wiped ? 'raid-sim-wiped' : 'raid-sim-held'}`}>
              <span>
                <PixelIcon name={s.wiped ? 'friend' : 'skull'} size={12} /> {raidLine(s, i)}
              </span>
            </li>
          ))}
          <li className="muted">Raid {sim.shown + 1} in progress…</li>
        </ul>
      )}

      {/* Summary + last 3 selectable cards when done */}
      {done && (
        <>
          <p className={`raid-sim-summary ${wiped ? 'raid-sim-wiped' : 'muted'}`}>
            {wiped
              ? `Robbed at raid ${sim.steps.length} — dungeon lost.`
              : sim.end === 'autoClose'
                ? `Planned stop at raid ${sim.steps[sim.steps.length - 1]?.winsAfter ?? 0} reached.`
                : sim.end === 'claimed'
                  ? `Claimed after ${sim.steps.length} raids.`
                  : `Held all ${sim.steps.length} raids — dungeon survived.`}
            {' · '}
            <button type="button" className="ghost" onClick={onClose}>Hide</button>
          </p>

          {sim.steps.length >= 1 && (
            <>
              <p className="card-label raid-sim-last-label">
                LAST {Math.min(3, sim.steps.length)} RAIDS{onWatch ? ' — ▶ Watch to see a raid live' : ''}
              </p>
              <div className="raid-sim-cards">
                {last3.map((s, idx) => {
                  const raidNum = last3Start + idx + 1
                  return (
                    <div key={idx} className={`raid-sim-card ${s.wiped ? 'raid-sim-card--wiped' : 'raid-sim-card--held'}`}>
                      <div className="raid-sim-card-num">Raider {raidNum}</div>
                      <div className="raid-sim-card-outcome">
                        <PixelIcon name={s.wiped ? 'friend' : 'skull'} size={14} />
                        {s.wiped
                          ? ' CLEARED — raider won'
                          : ` died floor ${s.floor} · bank $${s.bankAfter.toFixed(2)}`}
                      </div>
                      {onWatch && s.wiped && (
                        <button type="button" className="ghost raid-sim-watch-btn" onClick={() => onWatch(s)}>
                          ▶ Watch clear
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

export function MyDungeons({
  owned,
  historyCount,
  walletBalance: _walletBalance,
  ticketUsd,
  onHistory,
  onClaim,
  onExtend,
  onRaidStep,
  onBack,
  suggestClose,
  softEntryQuote,
  hardEntryQuote,
  onWatchSim,
}: Props) {
  const live = owned.filter((d) => d.status !== 'closed')
  const finished = owned.filter((d) => d.status === 'closed').slice().reverse()
  const [viewing, setViewing] = useState<DungeonBlueprint | null>(null)
  const [sim, setSim] = useState<RaidSim | null>(null)
  /** Completed simulation logs keyed by dungeon id — persist across sim open/close. */
  const [simLogs, setSimLogs] = useState<Record<string, RaidSim>>({})
  /** Dungeon ids whose sim log is currently hidden by the user. */
  const [hiddenLogs, setHiddenLogs] = useState<Set<string>>(new Set())
  /** Extend picker value per paused dungeon. */
  const [extendBy, setExtendBy] = useState<Record<string, number>>({})
  const simRunning = sim !== null && sim.shown < sim.steps.length
  const onRaidStepRef = useRef(onRaidStep)
  onRaidStepRef.current = onRaidStep
  const simRef = useRef(sim)
  simRef.current = sim

  useEffect(() => {
    if (!sim || sim.shown >= sim.steps.length) return
    const t = setTimeout(() => {
      onRaidStepRef.current(sim.id, sim.steps[sim.shown]!)
      setSim({ ...sim, shown: sim.shown + 1 })
    }, SIM_STEP_MS)
    return () => clearTimeout(t)
  }, [sim])

  // Save completed sim to persistent log
  useEffect(() => {
    if (!sim || sim.shown < sim.steps.length) return
    setSimLogs((prev) => ({ ...prev, [sim.id]: sim }))
  }, [sim])

  // Leaving mid-simulation still settles the raids that were rolled.
  useEffect(
    () => () => {
      const s = simRef.current
      if (!s) return
      for (let i = s.shown; i < s.steps.length; i++) onRaidStepRef.current(s.id, s.steps[i]!)
    },
    [],
  )

  const viewPerks = useMemo(
    () => (viewing ? perksFromBlueprint(viewing) : createEmptySideState<DungeonPerkId>()),
    [viewing],
  )

  const previewRaid = useMemo(() => {
    if (!viewing) return null
    const base = startRaid(viewing)
    return syncRaidWithPerks(base, {
      ...createEmptyPerksState(),
      dungeon: viewPerks,
    })
  }, [viewing, viewPerks])

  const hasFog = (viewPerks.ranks.fog ?? 0) > 0

  /** Show sim panel for a dungeon: active sim takes priority, then logged (if not hidden). */
  const renderSimPanel = (bp: DungeonBlueprint) => {
    const isActive = sim?.id === bp.id
    const makeWatchHandler = (_sim: RaidSim) =>
      onWatchSim
        ? (step: RaidStep) => onWatchSim(bp, step.friendPickSequence as string[], step.raidSeed)
        : undefined
    if (isActive) {
      return (
        <RaidSimPanel
          sim={sim!}
          onClose={() => {
            setSim(null)
            setHiddenLogs((s) => new Set([...s, bp.id]))
          }}
          onWatch={makeWatchHandler(sim!)}
        />
      )
    }
    const logged = simLogs[bp.id]
    if (!logged || hiddenLogs.has(bp.id)) return null
    return (
      <RaidSimPanel
        sim={logged}
        onClose={() => setHiddenLogs((s) => new Set([...s, bp.id]))}
        onWatch={makeWatchHandler(logged)}
      />
    )
  }

  /** Claim is allowed between simulated raids: the raids not yet shown never happen. */
  const claim = (id: string) => {
    const s = simRef.current
    if (s && s.id === id && s.shown < s.steps.length) {
      const cut = { ...s, steps: s.steps.slice(0, s.shown), end: 'claimed' as const }
      simRef.current = cut
      setSim(cut)
    }
    onClaim(id)
  }

  /** Dungeon waiting for the "claim before the plan" confirmation. */
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const confirmBp = confirmId ? live.find((d) => d.id === confirmId) ?? null : null
  const quoteFor = (bp: DungeonBlueprint) => ((bp.tier ?? 'soft') === 'hard' ? hardEntryQuote : softEntryQuote)
  const requestClaim = (bp: DungeonBlueprint) => (isPaused(bp) ? claim(bp.id) : setConfirmId(bp.id))
  const confirmRef = useRef<() => void>(() => {})
  confirmRef.current = () => {
    if (confirmBp) claim(confirmBp.id)
    setConfirmId(null)
  }

  useEffect(() => {
    if (!confirmId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setConfirmId(null)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        confirmRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirmId])

  useEffect(() => {
    if (!viewing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setViewing(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewing])

  if (viewing && previewRaid) {
    const viewTier = viewing.tier ?? 'soft'
    return (
      <div className="screen create-screen create-confirm">
        <div className="create-confirm-stage">
          <DungeonCanvas
            raid={previewRaid}
            boardOpacity={1}
            pitCliffStyle={viewing.pitCliffStyle ?? 4}
            liteFogPreview={hasFog}
          />
          {/* HUD overlay — no header in the grid so the stage fills the full viewport */}
          <div className="dungeon-view-hud">
            <button type="button" className="ghost dungeon-view-back" onClick={() => setViewing(null)}>
              ← Back
            </button>
            <span className="dungeon-view-info">
              {viewing.name} · {viewTier} · ${(viewing.bank ?? 0).toFixed(2)} · wins {viewing.wins ?? 0} · Esc
            </span>
          </div>
          <PerkSlotsBar
            variant="create"
            dungeonSlots={viewPerks.slots}
            dungeonRanks={viewPerks.ranks}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="screen my-dungeons-screen">
      <header className="screen-header">
        <button type="button" className="ghost" onClick={onBack}>
          ← Back
        </button>
        <h1>MY DUNGEONS</h1>
        {/* wallet balance hidden from My Dungeons header */}
      </header>

      <button type="button" className="card history-tile" onClick={onHistory}>
        <PixelIcon name="tomb" size={30} />
        <span className="history-tile-text">
          <span className="action-title">HISTORY</span>
          <span className="card-sub">{historyCount} events</span>
        </span>
        <span className="tile-arrow">→</span>
      </button>

      <section>
        <h2 className="section-title">Live</h2>
        {live.length === 0 && <p className="muted">No live dungeons — create one from the menu.</p>}
        {(live.length > 0 || finished.length > 0) && (
          <div className="owned-list">
            {live.map((bp) => {
              const tier = bp.tier ?? 'soft'
              const cfg = tier === 'hard' ? HARD : SOFT
              const wins = bp.wins ?? 0
              const suggest = suggestClose?.(bp) ?? false
              const tax = tier === 'hard' ? claimTaxFrac(wins) : 0
              const taxPct = Math.round(tax * 100)
              const tickets = bp.ticketPower ?? 0
              const close = closeNowPayout(bp)
              const invested = bp.invested ?? cfg.createCost
              const paused = isPaused(bp)
              const extMax = Math.max(0, MAX_RAIDS - wins)
              const ext = Math.min(extendBy[bp.id] ?? 1, extMax)
              const proj = paused && ext > 0 ? projectAfter(bp, ext, quoteFor(bp)) : null
              return (
                <Fragment key={bp.id}>
                <article className={`owned-card card${suggest ? ' owned-card--ready' : ''}`}>
                  <MapPreview blueprint={bp} onClick={() => setViewing(bp)} />
                  <div className="owned-card-meta">
                    <div className="owned-card-title">
                      <span className={`tier-chip tier-chip--${tier}`}>{tier === 'hard' ? 'hard' : 'simple'}</span>
                      <strong>{bp.name}</strong>
                      {suggest && <span className="ready-chip">READY TO CLOSE ✓</span>}
                      {paused ? (
                        <span className="paused-chip">PAUSED AT {bp.closeAtWins} RAIDS — CLAIM OR EXTEND</span>
                      ) : (
                        bp.closeAtWins != null && (
                          <span className="autoclose-chip">STOPS AFTER {bp.closeAtWins} RAIDS</span>
                        )
                      )}
                    </div>
                    {proj ? (
                      <YieldDash
                        tier={tier}
                        youGet={proj.payout}
                        invested={invested}
                        taxFrac={proj.tax}
                        raidsKey="LEVEL OF DUNGEON"
                        raidsHint={LEVEL_HINT}
                        raids={proj.wins}
                        raidsSub={`if it survives +${ext} ${ext === 1 ? 'raid' : 'raids'}`}
                        tickets={proj.tickets}
                        ticketsUsd={ticketUsd(proj.tickets)}
                      />
                    ) : (
                      <YieldDash
                        tier={tier}
                        youGet={close.payout}
                        invested={invested}
                        taxFrac={tax}
                        raidsKey="LEVEL OF DUNGEON"
                        raidsHint={LEVEL_HINT}
                        raids={wins}
                        raidsSub={bp.closeAtWins != null ? `stops after ${bp.closeAtWins}` : 'up to 25 raids'}
                        tickets={tickets}
                        ticketsUsd={ticketUsd(tickets)}
                      />
                    )}
                    <div className="owned-actions">
                      {paused && extMax > 0 ? (
                        <div className="extend-picker">
                          <button
                            type="button"
                            className="ghost"
                            aria-label="Fewer raids"
                            disabled={ext <= 1}
                            onClick={() => setExtendBy((m) => ({ ...m, [bp.id]: ext - 1 }))}
                          >
                            −
                          </button>
                          <span className="extend-picker-n">{ext}</span>
                          <button
                            type="button"
                            className="ghost"
                            aria-label="More raids"
                            disabled={ext >= extMax}
                            onClick={() => setExtendBy((m) => ({ ...m, [bp.id]: ext + 1 }))}
                          >
                            +
                          </button>
                          <button type="button" className="ghost extend-btn" onClick={() => onExtend(bp.id, ext)}>
                            Extend +{ext} {ext === 1 ? 'raid' : 'raids'}
                          </button>
                        </div>
                      ) : (
                        !paused && (
                          <button
                            type="button"
                            className="ghost"
                            disabled={simRunning}
                            onClick={() => {
                              setHiddenLogs((s) => { const n = new Set(s); n.delete(bp.id); return n })
                              setSim(planRaidSim(bp))
                            }}
                          >
                            {simLogs[bp.id] ? 'Simulate again' : 'Simulate raids'}
                          </button>
                        )
                      )}
                      <button
                        type="button"
                        className="claim-btn"
                        onClick={() => requestClaim(bp)}
                      >
                        {taxPct > 0
                          ? `Claim ${money(close.payout)} (tax ${taxPct}%)`
                          : `Claim ${money(close.payout)}${suggest ? ' ✓' : ''}`}
                      </button>
                    </div>
                  </div>
                </article>
                {renderSimPanel(bp)}
                </Fragment>
              )
            })}
            {finished.map((bp) => (
              <Fragment key={bp.id}>
                <FinishedCard bp={bp} onView={() => setViewing(bp)} />
                {renderSimPanel(bp)}
              </Fragment>
            ))}
          </div>
        )}
      </section>

      {confirmBp && (
        <ClaimConfirm
          bp={confirmBp}
          quote={quoteFor(confirmBp)}
          onCancel={() => setConfirmId(null)}
          onConfirm={() => confirmRef.current()}
        />
      )}

    </div>
  )
}

/** Claimed or robbed: greyed out, result frozen, map still opens. */
function FinishedCard({ bp }: { bp: DungeonBlueprint; onView?: () => void }) {
  const tier = bp.tier ?? 'soft'
  const invested = bp.invested ?? (tier === 'hard' ? HARD : SOFT).createCost
  const got = bp.withdrawn ?? 0
  const profit = got - invested
  const pctGain = invested > 0 ? Math.round((profit / invested) * 100) : 0
  const up = profit >= -0.005
  return (
    <article className="owned-card owned-card--finished card">
      <MapPreview blueprint={bp} onClick={undefined} />
      <div className="owned-card-meta">
        <div className="owned-card-title">
          <span className={`tier-chip tier-chip--${tier}`}>{tier === 'hard' ? 'hard' : 'simple'}</span>
          <strong>{bp.name}</strong>
          <span className="finished-chip">{bp.wiped ? 'ROBBED' : 'CLAIMED'}</span>
        </div>
        <div className={`finished-badge ${up ? 'finished-badge--win' : 'finished-badge--loss'}`}>
          <span className="finished-badge-x">{up ? '+' : '−'}{Math.abs(pctGain)}% · {up ? '+' : '−'}{money(Math.abs(profit))}</span>
          <span className="finished-badge-sub">level {bp.wins ?? 0} · invested {money(invested)}</span>
        </div>
      </div>
    </article>
  )
}

function ClaimConfirm({
  bp,
  quote,
  onCancel,
  onConfirm,
}: {
  bp: DungeonBlueprint
  quote: EntryQuote
  onCancel: () => void
  onConfirm: () => void
}) {
  const now = closeNowPayout(bp).payout
  const wins = bp.wins ?? 0
  const planAt = bp.closeAtWins != null && bp.closeAtWins > wins ? bp.closeAtWins : null
  const planned = planAt != null ? projectAfter(bp, planAt - wins, quote).payout : null
  const miss = planned != null ? planned - now : 0
  return (
    <div className="create-leave create-leave--fixed" role="alertdialog" aria-label="Claim before the plan" onClick={onCancel}>
      <div className="card create-leave-card" onClick={(e) => e.stopPropagation()}>
        <div className="action-title">CLAIM NOW?</div>
        <p className="card-sub">
          {planAt != null
            ? `You are claiming before the planned close (after ${planAt} raids). The dungeon closes now.`
            : 'The dungeon closes now and takes no more raids.'}
        </p>
        <div className="claim-confirm-rows">
          <div className="stat-line">
            <span>You get now</span>
            <strong className="txt-win">{money(now)}</strong>
          </div>
          {planned != null && (
            <>
              <div className="stat-line">
                <span>At planned close ({planAt} raids)</span>
                <strong>{money(planned)}</strong>
              </div>
              {miss > 0.005 && (
                <div className="stat-line">
                  <span>You miss</span>
                  <strong className="txt-loss">−{money(miss)}</strong>
                </div>
              )}
            </>
          )}
        </div>
        <div className="create-leave-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel · Esc
          </button>
          <button type="button" className="claim-btn" onClick={onConfirm}>
            Claim {money(now)} · Enter
          </button>
        </div>
      </div>
    </div>
  )
}
