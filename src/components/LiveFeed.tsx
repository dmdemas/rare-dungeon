/**
 * LIVE EVENTS: vertical world feed from the pre-simulated raids. Newest on top;
 * every 10–15 s a row drops in and pushes the rest one row down.
 */
import { useState } from 'react'
import { feedEvent, type GameEvent } from '../game/world'
import { PixelIcon, type PixelIconName } from './ui/PixelIcon'
import { money, timeAgo } from './ui/format'
import { useFeedRotation } from './useFeedRotation'
import { useNow } from './ui/useNow'

const INTERVAL_BASE_MS = 10_000
const INTERVAL_JITTER_MS = 5_000
const MAX_ROWS = 16
/** Replayed events older than this are re-stamped as happening now. */
const STALE_MS = 60_000

type Row = { uid: number; ev: GameEvent }
let uidSeq = 0

const usd = (x: number) => money(x, x >= 100 || Number.isInteger(x) ? 0 : 2)

export type EventView = {
  icon: PixelIconName
  tone: 'win' | 'loss'
  actor: string
  verb: string
  value: string
  tail: string
}

export function eventView(ev: GameEvent): EventView {
  const it = ev.item
  switch (it.kind) {
    case 'clear':
      return {
        icon: 'friend',
        tone: 'win',
        actor: 'Friend',
        verb: 'earned',
        value: `${(it.payout / Math.max(1e-9, it.paid)).toFixed(1)}x (${money(it.payout, 2)})`,
        tail: `from raid (invested ${usd(it.paid)})`,
      }
    case 'claim':
      return {
        icon: 'coins',
        tone: 'win',
        actor: 'Claimed —',
        verb: 'earned',
        value: `+${usd(it.payout)}`,
        tail: `from dungeon (invested ${usd(it.invested)})`,
      }
    case 'fail':
      return {
        icon: 'skull',
        tone: 'loss',
        actor: 'Raid failed — Friend',
        verb: 'lost',
        value: usd(it.lost),
        tail: `on floor ${it.floor}`,
      }
    case 'wiped':
      return {
        icon: 'skull',
        tone: 'loss',
        actor: 'Dungeon holder',
        verb: 'lost',
        value: usd(it.lost),
        tail: `dungeon robbed at ${it.wins} wins`,
      }
  }
}

export function LiveFeed({ events, maxRows }: { events: GameEvent[]; maxRows?: number }) {
  const limit = maxRows ?? MAX_ROWS
  const [rows, setRows] = useState<Row[]>(() =>
    events
      .slice(-limit)
      .reverse()
      .map((ev) => ({ uid: ++uidSeq, ev })),
  )
  const [newest, setNewest] = useState(-1)
  const now = useNow(15_000)

  useFeedRotation(events, INTERVAL_BASE_MS, INTERVAL_JITTER_MS, (ev) => {
    const fresh = Date.now() - ev.at > STALE_MS ? feedEvent(ev.item) : ev
    const uid = ++uidSeq
    setNewest(uid)
    setRows((prev) => [{ uid, ev: fresh }, ...prev].slice(0, limit))
  })

  return (
    <section className="card live-feed" aria-label="Live events">
      <div className="live-feed-head">LIVE EVENTS</div>
      <div className="live-feed-list">
        {rows.map(({ uid, ev }) => {
          const v = eventView(ev)
          return (
            <div key={uid} className={`live-row live-row--${v.tone}${uid === newest ? ' live-row--new' : ''}`}>
              <div className="live-row-inner">
                <PixelIcon name={v.icon} size={22} className="live-row-icon" />
                <div className="live-row-body">
                  <div className="live-row-who">
                    {v.actor} {ev.who}
                    <span className={`tier-chip tier-chip--${ev.item.tier}`}>{ev.item.tier}</span>
                  </div>
                  <div className="live-row-what">
                    {v.verb} <strong>{v.value}</strong> {v.tail}
                  </div>
                  <div className="live-row-when">{timeAgo(ev.at, now)}</div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
