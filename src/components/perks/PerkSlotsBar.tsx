import { useState } from 'react'
import { assetUrl } from '../../assetUrl'
import {
  getPerkDef,
  perkIconUrl,
  slotDisplayRank,
  type DungeonPerkId,
  type FriendPerkId,
  type PerkId,
  type PerkRank,
  type PerkSlotHistory,
} from '../../game/perks'

const RANK_MARK: Record<PerkRank, string> = { 1: 'I', 2: 'II', 3: 'III' }

type PlayProps = {
  variant: 'play'
  friendSlots: PerkSlotHistory<FriendPerkId>
  dungeonSlots: PerkSlotHistory<DungeonPerkId>
  friendRanks: Partial<Record<FriendPerkId, PerkRank>>
  dungeonRanks: Partial<Record<DungeonPerkId, PerkRank>>
}

type CreateProps = {
  variant: 'create'
  dungeonSlots: PerkSlotHistory<DungeonPerkId>
  dungeonRanks: Partial<Record<DungeonPerkId, PerkRank>>
}

type Props = PlayProps | CreateProps

export function PerkSlotsBar(props: Props) {
  if (props.variant === 'create') {
    return (
      <div className="perk-slots-bar perk-slots-bar--create">
        <SlotRow
          side="dungeon"
          slots={props.dungeonSlots}
          ranks={props.dungeonRanks}
          emptySrc={assetUrl('/refs.perk/DungeonPerkSlot.png') + '?v=eq1'}
        />
      </div>
    )
  }

  return (
    <div className="perk-slots-bar perk-slots-bar--play">
      <SlotRow
        side="friend"
        slots={props.friendSlots}
        ranks={props.friendRanks}
        emptySrc={assetUrl('/refs.perk/FriendPerkSlot.png') + '?v=eq1'}
      />
      <SlotRow
        side="dungeon"
        slots={props.dungeonSlots}
        ranks={props.dungeonRanks}
        emptySrc={assetUrl('/refs.perk/DungeonPerkSlot.png') + '?v=eq1'}
      />
    </div>
  )
}

function SlotRow<T extends PerkId>({
  side,
  slots,
  ranks,
  emptySrc,
}: {
  side: 'friend' | 'dungeon'
  slots: PerkSlotHistory<T>
  ranks: Partial<Record<T, PerkRank>>
  emptySrc: string
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const hoverId = hoverIndex != null ? slots[hoverIndex] : null
  const hoverDef = hoverId ? getPerkDef(hoverId) : null
  const hoverRank =
    hoverIndex != null && hoverId ? slotDisplayRank(slots, hoverIndex) : 1
  const liveRank = hoverId ? (ranks[hoverId] ?? 1) : 1

  return (
    <div className={`perk-slot-row perk-slot-row--${side}`} aria-label={`${side} perks`}>
      {slots.map((id, i) => {
        if (!id) {
          return (
            <div key={i} className="perk-slot perk-slot--empty">
              <img src={emptySrc} alt="" draggable={false} />
            </div>
          )
        }
        const def = getPerkDef(id)
        const rank = slotDisplayRank(slots, i)
        return (
          <div
            key={i}
            className="perk-slot perk-slot--filled"
            onMouseEnter={() => setHoverIndex(i)}
            onMouseLeave={() => setHoverIndex(null)}
          >
            <img
              className="perk-slot-art"
              src={perkIconUrl(def.iconPath)}
              alt={def.name}
              draggable={false}
            />
            <span className="perk-slot-rank">{RANK_MARK[rank]}</span>
          </div>
        )
      })}
      {hoverDef && (
        <div className={`perk-slot-tooltip perk-slot-tooltip--${side}`} role="tooltip">
          <strong>
            {hoverDef.name} {RANK_MARK[hoverRank]}
          </strong>
          <div>Type: {hoverDef.type}</div>
          <p>{hoverDef.rule}</p>
          <div className="perk-offer-tooltip-ranks">
            {hoverDef.ranks.map((text, i) => {
              const r = (i + 1) as PerkRank
              const cls = r === hoverRank ? 'is-cur' : r === liveRank ? 'is-live' : ''
              const mark = RANK_MARK[r]
              return (
                <span key={mark} className={cls}>
                  {mark}: {text}
                </span>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
