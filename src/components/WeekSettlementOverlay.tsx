/**
 * Shown when the week closes: displays ticket payout, share breakdown,
 * and confirms reset before starting the next week.
 */
import { useEffect, useState } from 'react'

type Props = {
  weekNumber: number
  ticketPayout: number
  /** Real player's combined ticket power (owned dungeons + raider). */
  playerPower: number
  /** Total power including AI players. */
  totalPower: number
  /** How much of the pool was burned this week. */
  burned: number
  /** How much rolls over to next week (75% of after-burn pool). */
  rollover: number
  onContinue: () => void
}

export function WeekSettlementOverlay({
  weekNumber,
  ticketPayout,
  playerPower,
  totalPower,
  burned,
  rollover,
  onContinue,
}: Props) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const sharePct = totalPower > 0 ? ((playerPower / totalPower) * 100).toFixed(1) : '0.0'
  const hasTickets = playerPower > 0

  return (
    <div className={`outcome-overlay${visible ? ' is-in' : ''}`}>
      <div className="outcome-card outcome-card--week">
        <h1>WEEK #{weekNumber} CLOSED</h1>
        <p className="muted">Weekly pool distributed to all ticket holders.</p>

        {hasTickets ? (
          <>
            <p className="outcome-payout">+${ticketPayout.toFixed(2)}</p>
            <p className="muted">
              Your share: <strong>{sharePct}%</strong> of ticket pot
              &nbsp;({playerPower.toFixed(0)} / {totalPower.toFixed(0)} tickets)
            </p>
          </>
        ) : (
          <p className="muted" style={{ color: '#c44' }}>
            No tickets this week — hold Hard dungeons past win&nbsp;7 to earn pool shares.
          </p>
        )}

        <div className="week-settle-details">
          <span className="muted tiny">Burned: ${burned.toFixed(2)} (0.5% protocol)</span>
          <span className="muted tiny">Rollover to next week: ${rollover.toFixed(2)}</span>
        </div>

        <button type="button" className="connect" onClick={onContinue}>
          Start Week #{weekNumber + 1} →
        </button>
      </div>
    </div>
  )
}
