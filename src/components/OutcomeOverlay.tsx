import { useEffect, useRef, useState } from 'react'
import { tix, winX } from './ui/format'

type Props = {
  result: 'won' | 'dead' | 'surrendered'
  dungeonName: string
  floor: number
  payout?: number
  /** Entry $ paid this raid — for × vs stake. */
  entryPaid?: number
  tickets?: number
  ticketBalance?: number
  note?: string
  onMenu: () => void
}

/** Win reveal (ms from mount): tickets (if any), ×, $ each drop in for DROP_MS and count up. */
const FIRST_AT = 500
const DROP_MS = 1000
/** Tickets and × count up fast while they land; the $ counts after landing. */
const QUICK_COUNT_MS = 700
const COUNT_MS = 1500

function winTimeline(hasTickets: boolean) {
  const ticketsAt = FIRST_AT
  const xAt = hasTickets ? ticketsAt + DROP_MS : FIRST_AT
  const moneyAt = xAt + DROP_MS
  const countAt = moneyAt + DROP_MS
  return { ticketsAt, xAt, moneyAt, countAt, doneAt: countAt + COUNT_MS }
}

/** 0 → 1 between `from` and `from + ms`, easing out. */
function countUp(t: number, from: number, ms: number) {
  const u = Math.min(1, Math.max(0, (t - from) / ms))
  return 1 - Math.pow(1 - u, 4)
}

/** Milliseconds since mount; `finish()` jumps straight to the end. */
function useTimeline(end: number) {
  const startRef = useRef(performance.now())
  const [t, setT] = useState(0)
  useEffect(() => {
    let raf = 0
    const tick = (now: number) => {
      const e = now - startRef.current
      setT(e)
      if (e < end) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [end])
  const finish = () => {
    startRef.current = performance.now() - end
    setT(end)
  }
  return { t, finish }
}

export function OutcomeOverlay({
  result,
  dungeonName,
  floor,
  payout,
  entryPaid,
  tickets = 0,
  onMenu,
}: Props) {
  const won = result === 'won'
  const tl = winTimeline(tickets > 0)
  const { t, finish } = useTimeline(won ? tl.doneAt : 0)
  const done = t >= tl.doneAt
  const [visible, setVisible] = useState(false)
  const keyRef = useRef({ won, done, finish, onMenu })
  keyRef.current = { won, done, finish, onMenu }

  useEffect(() => {
    const id = window.requestAnimationFrame(() => setVisible(true))
    return () => window.cancelAnimationFrame(id)
  }, [])

  // Enter: first finishes the win reveal, then claims / leaves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      e.preventDefault()
      const k = keyRef.current
      if (k.won && !k.done) k.finish()
      else k.onMenu()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!won) {
    return (
      <div className={`outcome-overlay${visible ? ' is-in' : ''}`}>
        <div className="outcome-card outcome-card--fixed outcome-card--lost">
          <h1 className="outcome-title">GAME OVER</h1>
          <p className="muted">
            {result === 'dead' ? `Stamina ran out on floor ${floor}` : `You left ${dungeonName} on floor ${floor}`}.
          </p>
          <div className="outcome-lost-body">
            <p>Your entry goes to the dungeon&apos;s bank.</p>
            <p>The dungeon level goes up.</p>
          </div>
          <div className="outcome-actions is-in">
            <button type="button" className="connect" onClick={onMenu}>
              BACK TO MENU · ENTER
            </button>
            <button type="button" className="connect post-x-btn" onClick={() => {}}>
              POST ON X
            </button>
          </div>
        </div>
      </div>
    )
  }

  const paid = entryPaid && entryPaid > 0 ? entryPaid : null
  const x = paid != null && payout != null ? payout / paid : null
  const money$ = (payout ?? 0) * countUp(t, tl.countAt, COUNT_MS)
  const ticketsNow = tickets * countUp(t, tl.ticketsAt + 300, QUICK_COUNT_MS)
  const xNow = (x ?? 0) * countUp(t, tl.xAt + 300, QUICK_COUNT_MS)
  return (
    <div className={`outcome-overlay${visible ? ' is-in' : ''}`}>
      <div className="outcome-card outcome-card--fixed outcome-card--win">
        <h1 className="outcome-title">YOU WON</h1>
        <p className="muted">Cleared all 3 floors of {dungeonName}.</p>
        <div className="outcome-drops">
          {tickets > 0 && (
            <div className="outcome-drop-slot">
              {t >= tl.ticketsAt && <p className="outcome-drop outcome-tickets">+{tix(ticketsNow)} TICKETS</p>}
            </div>
          )}
          <div className="outcome-drop-slot">
            {t >= tl.xAt && x != null && <p className="outcome-drop outcome-mult">{winX(xNow)}</p>}
          </div>
          <div className="outcome-drop-slot outcome-drop-slot--money">
            {t >= tl.moneyAt && payout != null && <p className="outcome-drop outcome-count">${money$.toFixed(2)}</p>}
          </div>
        </div>
        <div className={`outcome-actions${done ? ' is-in' : ''}`}>
          <button type="button" className="connect" onClick={onMenu} disabled={!done}>
            CLAIM REWARD · ENTER
          </button>
          <button type="button" className="connect post-x-btn" onClick={() => {}}>
            POST ON X
          </button>
        </div>
      </div>
    </div>
  )
}
