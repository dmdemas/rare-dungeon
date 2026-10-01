import { useEffect, useState } from 'react'
import { assetUrl } from '../assetUrl'
import {
  PERK_SLOT_COUNT,
  apply,
  createEmptyPerksState,
  createEmptySideState,
  nextSlotIndex,
  rollOffer,
  selectPerk,
  syncRaidWithPerks,
  type DungeonPerkId,
  type PerkOffer,
  type SidePerkState,
} from '../game/perks'
import { mulberry32 } from '../game/rng'
import { cloneRaid, startRaid } from '../game/raid'
import { rebuildWallSet, relocateOffPits } from '../game/mapGen'
import type { DungeonBlueprint, RaidState } from '../game/types'
import type { DungeonTier } from '../game/economy'
import { ClosePlan, defaultCloseAt } from './ClosePlan'
import { DungeonCanvas } from './DungeonCanvas'
import { MapPreview } from './MapPreview'
import { money } from './ui/format'
import { PerkOfferOverlay } from './perks/PerkOfferOverlay'
import { PerkSlotsBar } from './perks/PerkSlotsBar'

type Props = {
  options: DungeonBlueprint[]
  /** Create price — charged by `onPay` when a layout is picked, never refunded. */
  createCost: number
  /** Charge the create fee; false = could not pay (App returns to the menu). */
  onPay: () => boolean
  onPick: (bp: DungeonBlueprint) => void
  onBack: () => void
  /** $ a ticket count would take from the pool if the week ended now. */
  ticketUsd: (tickets: number) => number
  /** Hard create — dungeon offer reroll (same ladder as Friend). */
  offerReroll?: {
    walletBalance: number
    nextCost: (already: number) => number
    tryPay: (already: number) => boolean
  } | null
}

export function CreateDungeon({ options, createCost, onPay: _onPay, onPick, onBack, ticketUsd, offerReroll = null }: Props) {
  const tier: DungeonTier = options[0]?.tier ?? 'soft'
  const [selected, setSelected] = useState<DungeonBlueprint | null>(null)
  const [dungeonPerks, setDungeonPerks] = useState<SidePerkState<DungeonPerkId>>(() =>
    createEmptySideState(),
  )
  const [offer, setOffer] = useState<PerkOffer<DungeonPerkId> | null>(null)
  const [perkRound, setPerkRound] = useState(1)
  const [offerRerolls, setOfferRerolls] = useState(0)
  const [closeAt, setCloseAt] = useState<number | null>(() => defaultCloseAt(tier))
  /** Esc while setting up a paid dungeon asks first. */
  const [confirmLeave, setConfirmLeave] = useState(false)
  /** Confirm before leaving Screen 1 (fee already paid upfront). */
  const [confirmLeaveEarly, setConfirmLeaveEarly] = useState(false)
  /** Sticky preview — pits/horde accumulate; never re-roll prior pits. */
  const [previewRaid, setPreviewRaid] = useState<RaidState | null>(null)

  const hasFog = (dungeonPerks.ranks.fog ?? 0) > 0
  const slotsFull = nextSlotIndex(dungeonPerks.slots) < 0

  const selectBlueprint = (bp: DungeonBlueprint) => {
    setSelected(bp)
    setDungeonPerks(createEmptySideState())
    setPerkRound(1)
    setOffer(null)
    setOfferRerolls(0)
    setPreviewRaid(startRaid(bp))
  }

  // Roll a fresh offer for the current perk round (once per empty offer).
  useEffect(() => {
    if (!selected || slotsFull) {
      setOffer(null)
      return
    }
    if (offer) return
    const seed = (Math.random() * 0x100000000) >>> 0
    // Keep offerRerolls across perk rounds — Hard ladder is per create session
    setOffer(rollOffer('dungeon', dungeonPerks.ranks, mulberry32(seed), selected?.isCorridor ?? false))
  }, [selected, perkRound, slotsFull, offer, dungeonPerks.ranks])

  const onRerollOffer = () => {
    if (!offerReroll || !offer || !selected) return
    if (!offerReroll.tryPay(offerRerolls)) return
    const seed = (Math.random() * 0x100000000) >>> 0
    setOffer(rollOffer('dungeon', dungeonPerks.ranks, mulberry32(seed), selected?.isCorridor ?? false))
    setOfferRerolls((n) => n + 1)
  }

  const finishCreate = () => {
    if (!selected || !slotsFull || !previewRaid) return
    const tiles = [...previewRaid.map.tiles]
    const walls = rebuildWallSet(tiles)
    const baseMobs = previewRaid.mobs.filter((m) => !m.fromHorde)
    const mobSpawns = relocateOffPits(
      tiles,
      baseMobs.map((m) => ({ x: m.x, y: m.y })),
      mulberry32(0x5150),
    )
    onPick({
      ...selected,
      map: { tiles, walls },
      mobSpawns,
      perkPitKeys: [...previewRaid.wallsPerkCells],
      dungeonPerks: {
        slots: dungeonPerks.slots,
        ranks: dungeonPerks.ranks as Record<string, 1 | 2 | 3>,
      },
      closeAtWins: closeAt ?? undefined,
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (confirmLeaveEarly) {
        if (e.key === 'Escape') { e.preventDefault(); setConfirmLeaveEarly(false) }
        else if (e.key === 'Enter') { e.preventDefault(); onBack() }
        return
      }
      if (confirmLeave) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setConfirmLeave(false)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          onBack()
        }
        return
      }
      if (e.key === 'Enter' && selected && slotsFull) {
        e.preventDefault()
        finishCreate()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        if (selected) setConfirmLeave(true)
        else setConfirmLeaveEarly(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, slotsFull, onPick, onBack, dungeonPerks, previewRaid, closeAt, confirmLeave, confirmLeaveEarly])

  const onPickPerk = (id: DungeonPerkId) => {
    if (!previewRaid) return
    const next = selectPerk(dungeonPerks, id)
    const rank = next.ranks[id]
    if (rank) apply(id, rank, { side: 'dungeon' })
    setDungeonPerks(next)
    const filled = nextSlotIndex(next.slots) < 0
    if (!filled) {
      setPerkRound((r) => Math.min(PERK_SLOT_COUNT, r + 1))
    }
    setOffer(null)
    // Sync onto the same raid so locked pits stay put
    const synced = syncRaidWithPerks(cloneRaid(previewRaid), {
      ...createEmptyPerksState(),
      dungeon: next,
    })
    setPreviewRaid(synced)
  }

  if (selected && previewRaid) {
    const roundNum = Math.min(PERK_SLOT_COUNT, Math.max(1, perkRound))
    return (
      <div className="screen create-screen create-confirm">
        <div className="create-confirm-stage">
          <DungeonCanvas
            raid={previewRaid}
            boardOpacity={1}
            pitCliffStyle={selected.pitCliffStyle ?? 4}
            revealAll={!hasFog}
            liteFogPreview={hasFog}
          />
          {!slotsFull && (
            <div className="floor-intro-overlay" style={{ opacity: 1 }} aria-hidden>
              <img
                src={assetUrl('/sprites/logo-name-sprite.png')}
                alt="RareDungeons"
                className="floor-intro-logo"
              />
              <div className="floor-intro-round">
                <img src={assetUrl('/sprites/floor-text.png')} alt="Floor" className="floor-intro-round-label" />
                <img
                  src={assetUrl(`/sprites/${roundNum}.png`)}
                  alt={`Floor ${roundNum}`}
                  className="floor-intro-round-num"
                />
              </div>
            </div>
          )}
          {!slotsFull && offer && (
            <PerkOfferOverlay
              label="Choose a Dungeon perk"
              side="dungeon"
              offer={offer}
              ranks={dungeonPerks.ranks}
              onPick={onPickPerk}
              reroll={
                offerReroll
                  ? {
                      cost: offerReroll.nextCost(offerRerolls),
                      disabled:
                        offerReroll.walletBalance < offerReroll.nextCost(offerRerolls),
                      onReroll: onRerollOffer,
                    }
                  : null
              }
            />
          )}
          <PerkSlotsBar
            variant="create"
            dungeonSlots={dungeonPerks.slots}
            dungeonRanks={dungeonPerks.ranks}
          />
          {slotsFull && (
            <div className="create-plan-dock">
              <ClosePlan tier={tier} value={closeAt} onChange={setCloseAt} ticketUsd={ticketUsd} />
              <button type="button" className="connect create-open-btn" onClick={finishCreate}>
                OPEN DUNGEON · ENTER
              </button>
            </div>
          )}
          {confirmLeave && (
            <div className="create-leave" role="alertdialog" aria-label="Leave dungeon creation">
              <div className="card create-leave-card">
                <div className="action-title">LEAVE DUNGEON CREATION?</div>
                <p className="card-sub">
                  The creation fee is not refunded (you lose <strong className="txt-loss">{money(createCost)}</strong>).
                </p>
                <div className="create-leave-actions">
                  <button type="button" className="ghost" onClick={() => setConfirmLeave(false)}>
                    STAY · ESC
                  </button>
                  <button type="button" className="ghost create-leave-go" onClick={onBack}>
                    LEAVE (−{money(createCost)}) · ENTER
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="screen create-screen create-pick">
      <header className="screen-header">
        <button type="button" className="ghost" onClick={() => setConfirmLeaveEarly(true)}>
          ← Back
        </button>
        <h1>
          CREATE DUNGEON{' '}
          <span className={`tier-chip tier-chip--${tier} tier-chip--lg`}>{tier === 'hard' ? 'hard' : 'simple'}</span>
        </h1>
        <p className="muted">
          Pick a layout — fee {money(createCost)} already paid — then choose 3 dungeon perks.
        </p>
      </header>
      <div className="preview-row">
        {options.map((bp) => (
          <MapPreview
            key={bp.id}
            blueprint={bp}
            selected={selected?.id === bp.id}
            mobsAsDots
            onClick={() => selectBlueprint(bp)}
          />
        ))}
      </div>

      {confirmLeaveEarly && (
        <div className="create-leave create-leave--fixed" role="alertdialog" aria-label="Leave dungeon creation" onClick={() => setConfirmLeaveEarly(false)}>
          <div className="card create-leave-card" onClick={(e) => e.stopPropagation()}>
            <div className="action-title">LEAVE DUNGEON CREATION?</div>
            <p className="card-sub">
              The {money(createCost)} create fee has already been paid and won't be refunded.
            </p>
            <div className="create-leave-actions">
              <button type="button" className="ghost" onClick={() => setConfirmLeaveEarly(false)}>
                STAY · ESC
              </button>
              <button type="button" className="ghost create-leave-go" onClick={onBack}>
                LEAVE (−{money(createCost)}) · ENTER
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
