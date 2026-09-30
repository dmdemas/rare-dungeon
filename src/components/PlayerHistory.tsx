import { useMemo, useState } from 'react'
import { cashFlow, isDungeonEvent, isRaidEvent, type PlayerEvent } from '../game/playerHistory'
import { PixelIcon, type PixelIconName } from './ui/PixelIcon'
import { money, timeAgo, tix } from './ui/format'
import { useNow } from './ui/useNow'

type Filter = 'all' | 'dungeons' | 'raids'

type Row = {
  icon: PixelIconName
  tone: 'win' | 'loss' | 'neutral'
  title: string
  value: string
  detail: string
}

export function rowView(e: PlayerEvent): Row {
  switch (e.kind) {
    case 'created':
      return { icon: 'invader', tone: 'neutral', title: 'Created dungeon', value: `−${money(e.cost)}`, detail: 'stake into bank + pool' }
    case 'defended':
      return {
        icon: 'chest',
        tone: 'win',
        title: 'Raider died in your dungeon',
        value: `+${money(e.bankAdd)} bank`,
        detail: `bank ${money(e.bankAfter)} · ${e.winsAfter} wins${e.ticketsMinted > 0 ? ` · +${tix(e.ticketsMinted)} tickets` : ''}`,
      }
    case 'robbed':
      return {
        icon: 'skull',
        tone: 'loss',
        title: 'Dungeon robbed',
        value: `−${money(e.invested)}`,
        detail: `Friend took ${money(e.raiderTook)} at ${e.wins} wins${e.ticketsLost > 0 ? ` · ${tix(e.ticketsLost)} tickets lost` : ''}`,
      }
    case 'closed': {
      const roi = e.invested > 0 ? e.payout / e.invested : 0
      return {
        icon: 'coins',
        tone: e.payout >= e.invested ? 'win' : 'loss',
        title: 'Closed dungeon',
        value: `+${money(e.payout)}`,
        detail: `${roi.toFixed(2)}× on ${money(e.invested)} · ${e.wins} wins${e.taxPct > 0 ? ` · tax ${e.taxPct}%` : ''}${e.ticketsKept > 0 ? ` · ${tix(e.ticketsKept)} tickets kept` : ''}`,
      }
    }
    case 'raidWon':
      return {
        icon: 'friend',
        tone: 'win',
        title: 'Raid won',
        value: `${(e.payout / Math.max(1e-9, e.paid)).toFixed(1)}x · +${money(e.payout)}`,
        detail: `invested ${money(e.paid)}${e.tickets > 0 ? ` · +${tix(e.tickets)} tickets` : ''}`,
      }
    case 'raidLost':
      return { icon: 'skull', tone: 'loss', title: 'Raid lost', value: `−${money(e.paid)}`, detail: `fell on floor ${e.floor}` }
    case 'weekPaid':
      return {
        icon: 'ticket',
        tone: e.payout > 0 ? 'win' : 'neutral',
        title: `Week ${e.week} ticket payout`,
        value: `+${money(e.payout)}`,
        detail: `${tix(e.tickets)} tickets`,
      }
  }
}

export function PlayerHistory({
  events,
  backLabel,
  onBack,
}: {
  events: PlayerEvent[]
  backLabel: string
  onBack: () => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const now = useNow(15_000)

  const stats = useMemo(() => {
    const count = (k: PlayerEvent['kind']) => events.filter((e) => e.kind === k).length
    return {
      created: count('created'),
      closed: count('closed'),
      robbed: count('robbed'),
      raids: count('raidWon') + count('raidLost'),
      raidsWon: count('raidWon'),
      net: events.reduce((s, e) => s + cashFlow(e), 0),
    }
  }, [events])

  const shown = useMemo(
    () =>
      events
        .filter((e) => (filter === 'all' ? true : filter === 'dungeons' ? isDungeonEvent(e) : isRaidEvent(e)))
        .slice()
        .reverse(),
    [events, filter],
  )

  return (
    <div className="screen history-screen">
      <header className="screen-header">
        <button type="button" className="ghost" onClick={onBack}>
          ← {backLabel}
        </button>
        <h1>HISTORY</h1>
      </header>

      <section className="history-stats">
        <HistoryStat k="DUNGEONS CREATED" v={String(stats.created)} />
        <HistoryStat k="CLOSED" v={String(stats.closed)} />
        <HistoryStat k="ROBBED" v={String(stats.robbed)} tone={stats.robbed > 0 ? 'loss' : undefined} />
        <HistoryStat k="RAIDS (WON)" v={`${stats.raids} (${stats.raidsWon})`} />
        <HistoryStat
          k="NET CASH"
          v={`${stats.net >= 0 ? '+' : '−'}${money(Math.abs(stats.net))}`}
          tone={stats.net >= 0 ? 'win' : 'loss'}
        />
      </section>

      <div className="history-filters">
        {(['all', 'dungeons', 'raids'] as const).map((f) => (
          <button key={f} type="button" className={filter === f ? 'active' : 'ghost'} onClick={() => setFilter(f)}>
            {f === 'all' ? 'ALL' : f === 'dungeons' ? 'MY DUNGEONS' : 'MY RAIDS'}
          </button>
        ))}
      </div>

      <section className="card history-list">
        {shown.length === 0 ? (
          <p className="muted history-empty">Nothing yet — create a dungeon or play a raid.</p>
        ) : (
          shown.map((e) => {
            const r = rowView(e)
            return (
              <div key={e.id} className={`history-row history-row--${r.tone}`}>
                <PixelIcon name={r.icon} size={22} className="history-row-icon" />
                <div className="history-row-body">
                  <div className="history-row-title">
                    {r.title}
                    <span className={`tier-chip tier-chip--${e.tier}`}>{e.tier}</span>
                    <span className="history-row-name">{e.name}</span>
                  </div>
                  <div className="history-row-detail">{r.detail}</div>
                </div>
                <div className="history-row-side">
                  <strong className="history-row-value">{r.value}</strong>
                  <span className="history-row-when">{timeAgo(e.at, now)}</span>
                </div>
              </div>
            )
          })
        )}
      </section>
    </div>
  )
}

function HistoryStat({ k, v, tone }: { k: string; v: string; tone?: 'win' | 'loss' }) {
  return (
    <div className="card portfolio-cell">
      <div className="card-label">{k}</div>
      <div className={`card-big card-big--sm${tone ? ` txt-${tone}` : ''}`}>{v}</div>
    </div>
  )
}
