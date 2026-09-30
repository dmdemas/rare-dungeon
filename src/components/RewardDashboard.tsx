import { HARD, SOFT, type DungeonTier } from '../game/economy'
import { raiderWinMult, ticketsOnClear } from '../game/worldStats'
import { money, tix, winX } from './ui/format'

type Props = {
  tier: DungeonTier
  bank: number
  tickets: number
  /** Entry actually paid by the raider (× is measured against it). */
  entryPaid: number
  /** $ these tickets would take from the reward pool if the week ended now. */
  ticketUsd?: (tickets: number) => number
  className?: string
}

export const LEVEL_HINT = 'Level of dungeon = the number of raiders who died in this dungeon.'

/** "If you win now": TO WIN $ | × — Hard adds the tickets you'd take (and their pool $). */
export function RewardDashboard({ tier, bank, tickets, entryPaid, ticketUsd, className }: Props) {
  const hard = tier === 'hard'
  const x = raiderWinMult(bank, tier, entryPaid)
  const payout = bank * (hard ? HARD : SOFT).clearRaiderFrac
  const youGet = hard ? ticketsOnClear(tickets) : 0
  const youGetUsd = youGet > 0 && ticketUsd ? ticketUsd(youGet) : 0
  return (
    <div className={`reward-dash reward-dash--${tier}${className ? ` ${className}` : ''}`}>
      <div className="reward-dash-cell">
        <span className="reward-dash-label">TO WIN</span>
        <strong className="reward-dash-val">{money(payout, payout >= 100 ? 0 : 2)}</strong>
        <span className="reward-dash-sub" />
      </div>
      <div className="reward-dash-cell">
        <span className="reward-dash-label">YOUR ×</span>
        <strong className="reward-dash-val">{winX(x)}</strong>
        <span className="reward-dash-sub" />
      </div>
      {hard && (
        <div className="reward-dash-cell reward-dash-cell--tickets">
          <span className="reward-dash-label">TICKETS</span>
          <strong className="reward-dash-val">{youGet > 0 ? tix(youGet) : '—'}</strong>
          <span className="reward-dash-sub">{youGet > 0 ? `(${money(youGetUsd)})` : ''}</span>
        </div>
      )}
    </div>
  )
}
