import { useState } from 'react'
import {
  getPerkDef,
  nextRankAfterPick,
  perkIconUrl,
  type PerkId,
  type PerkOffer,
  type PerkRank,
} from '../../game/perks'

type RerollProps = {
  cost: number
  disabled?: boolean
  onReroll: () => void
}

type Props<T extends PerkId> = {
  offer: PerkOffer<T>
  ranks: Partial<Record<T, PerkRank>>
  onPick: (id: T) => void
  label: string
  side: 'friend' | 'dungeon'
  reroll?: RerollProps | null
}

function PerkTooltip<T extends PerkId>({ id, ranks }: { id: T; ranks: Partial<Record<T, PerkRank>> }) {
  const def = getPerkDef(id)
  const next = nextRankAfterPick(ranks, id)
  if (next === null) return null
  return (
    <div className="perk-offer-tooltip" role="tooltip">
      <strong>{def.name}</strong>
      <div>Type: {def.type}</div>
      <p>{def.rule}</p>
      <div className="perk-offer-tooltip-ranks">
        {def.ranks.map((text, i) => {
          const r = (i + 1) as PerkRank
          const cls = r === next ? 'is-next' : next != null && r < next ? 'is-passed' : ''
          const mark = r === 1 ? 'I' : r === 2 ? 'II' : 'III'
          return (
            <span key={mark} className={cls}>
              {mark}: {text}
            </span>
          )
        })}
      </div>
    </div>
  )
}

export function PerkOfferOverlay<T extends PerkId>({
  offer,
  ranks,
  onPick,
  label,
  reroll = null,
}: Props<T>) {
  const [hoverId, setHoverId] = useState<T | null>(null)

  return (
    <div className="perk-offer-overlay" role="dialog" aria-label={label}>
      <div className="perk-offer-panel">
        <div className="perk-offer-cards">
          {offer.map((id) => {
            const def = getPerkDef(id)
            const lifted = hoverId === id
            return (
              <div key={id} className="perk-offer-half">
                {lifted && <PerkTooltip id={id} ranks={ranks} />}
                <button
                  type="button"
                  className={lifted ? 'perk-offer-card perk-offer-card--lift' : 'perk-offer-card'}
                  onClick={() => onPick(id)}
                  onMouseEnter={() => setHoverId(id)}
                  onMouseLeave={() => setHoverId(null)}
                >
                  <img
                    className="perk-offer-card-art"
                    src={perkIconUrl(def.iconPath)}
                    alt={def.name}
                    draggable={false}
                  />
                </button>
              </div>
            )
          })}
        </div>

        {reroll && (
          <button
            type="button"
            className="perk-offer-reroll"
            disabled={reroll.disabled}
            onClick={reroll.onReroll}
          >
            Reroll · ${reroll.cost.toFixed(2)}
          </button>
        )}
      </div>
    </div>
  )
}
