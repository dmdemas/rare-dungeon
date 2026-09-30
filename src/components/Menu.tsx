import { useEffect, useMemo, useRef, useState } from 'react'
import { assetUrl } from '../assetUrl'
import {
  HARD,
  SOFT,
  type DungeonTier,
  type WalletState,
} from '../game/economy'
import type { DungeonBlueprint } from '../game/types'
import type { GameEvent } from '../game/world'
import {
  ownerPortfolio,
  tierLiveStats,
  weekInflowBars,
  type TierLiveStats,
} from '../game/worldStats'
import type { PlayerEvent } from '../game/playerHistory'
import { LiveFeed } from './LiveFeed'
import { PixelIcon } from './ui/PixelIcon'
import { money, mult, tix } from './ui/format'
import { useNow } from './ui/useNow'

type Props = {
  wallet: WalletState
  weekNumber: number
  lastWeekBurn: number
  error?: string | null
  softEntryCost: number
  hardEntryCost: number
  hardEntryMul: number
  /** Every dungeon in the world (pre-simulated + player's). */
  worldPool: DungeonBlueprint[]
  owned: DungeonBlueprint[]
  nextTickAt: number
  lastPoolAdd: number
  playerTickets: number
  aiTickets: number
  /** Current weekday, 0 = Monday. */
  weekday: number
  /** Typical daily inflow of past weeks (level of past / projected bars). */
  baselineDaily: number
  /** Replayed world raids' pool inflow per step (day-to-day shape). */
  poolCents: number[]
  history: PlayerEvent[]
  feed: GameEvent[]
  onPlay: (tier: DungeonTier) => void
  onCreate: (tier: DungeonTier) => void
  onMyDungeons: () => void
  onHistory: () => void
  onSettleWeek: () => void
}

type Mode = 'home' | 'play' | 'create'
type Info = null | 'how' | 'economy' | 'deposit'

export function Menu(props: Props) {
  const { wallet, owned, worldPool, feed } = props
  const [mode, setMode] = useState<Mode>('home')
  const [info, setInfo] = useState<Info>(null)
  const now = useNow(1000)

  const raidable = useMemo(() => worldPool.filter((d) => !d.isOwned), [worldPool])
  const soft = useMemo(() => tierLiveStats(raidable, 'soft', props.softEntryCost), [raidable, props.softEntryCost])
  const hard = useMemo(() => tierLiveStats(raidable, 'hard', props.hardEntryCost), [raidable, props.hardEntryCost])
  const portfolio = useMemo(() => ownerPortfolio(owned), [owned])
  const ownedLive = owned.filter((d) => d.status !== 'closed')
  const tickIn = Math.max(0, Math.ceil((props.nextTickAt - now) / 1000))
  const bars = weekInflowBars({
    today: props.weekday,
    baselineDaily: props.baselineDaily,
    poolCents: props.poolCents,
  })
  const barMax = Math.max(1e-9, ...bars.map((b) => b.value))
  // lastRow removed — history card no longer shows last event preview

  return (
    <div className="menu-shell">
      <header className="top-bar">
        <div className="brand">
          <img src={assetUrl('/logo-name.png')} alt="RareDungeons" className="brand-logo-img" />
        </div>
        <nav className="top-nav">
          <button type="button" className="nav-btn" onClick={() => setInfo('how')}>
            HOW TO PLAY
          </button>
          <button type="button" className="nav-btn" onClick={() => setInfo('economy')}>
            ECONOMY
          </button>
        </nav>
        <div className="top-actions">
          <div className="wallet-chip">
            <PixelIcon name="wallet" size={16} />
            <div>
              <span className="wallet-chip-label">WALLET</span>
              <strong className="wallet-amount">{money(wallet.balance)}</strong>
            </div>
          </div>
          <div className="wallet-chip">
            <PixelIcon name="ticket" size={16} />
            <div>
              <span className="wallet-chip-label">MY TICKETS · WEEK {props.weekNumber}</span>
              <strong>{tix(props.playerTickets)}</strong>
            </div>
          </div>
          <button type="button" className="connect" onClick={() => setInfo('deposit')} title="Deposit funds">
            DEPOSIT →
          </button>
        </div>
      </header>

      {props.error && <p className="menu-error">{props.error}</p>}

      {/* ── Mobile-only layout (hidden on desktop via CSS) ── */}
      <div className="menu-mobile-layout">
        <div className="menu-mobile-top">
          <LiveFeed events={feed} maxRows={3} />
          <section className="card treasury-card treasury-card--mobile">
            <div className="treasury-main">
              <PixelIcon name="chest" size={28} />
              <div>
                <div className="card-label">TREASURY</div>
                <div className="card-big">{money(wallet.rewardPool, 2)}</div>
                <div className="pool-tick">next in {tickIn}s</div>
              </div>
            </div>
          </section>
        </div>

        <div className="menu-mobile-actions">
          <button type="button" className="card action-tile" onClick={() => setMode('play')}>
            <PixelIcon name="swords" size={52} />
            <span className="action-title">PLAY</span>
          </button>
          <button type="button" className="card action-tile" onClick={() => setMode('create')}>
            <img src={assetUrl('/dungeon-icon.png')} alt="Dungeon" className="action-tile-icon" />
            <span className="action-title">CREATE DUNGEON</span>
          </button>
        </div>

        <div className="menu-mobile-bottom">
          <button type="button" className="card my-dungeons-tile" onClick={props.onMyDungeons}>
            <PixelIcon name="tomb" size={28} />
            <div className="my-dungeons-info">
              <div className="action-title">
                MY DUNGEONS
                <span className="count-badge">{ownedLive.length}</span>
              </div>
            </div>
          </button>
          <button type="button" className="card history-card" onClick={props.onHistory}>
            <span className="action-title">HISTORY</span>
            <span className="tile-arrow history-arrow">→</span>
          </button>
        </div>
      </div>

      <div className="menu-grid">
        <aside className="menu-left">
          <LiveFeed events={feed} />
        </aside>

        <main className="menu-center">
          <section className="card treasury-card">
            <div className="treasury-main">
              <PixelIcon name="chest" size={40} />
              <div>
                <div className="card-label">TREASURY</div>
                <div className="card-big">{money(wallet.rewardPool, 2)}</div>
                <div className="pool-tick">
                  {props.lastPoolAdd > 0 && (
                    <>
                      <span className="txt-win">+{money(props.lastPoolAdd, 2)}</span> last raid ·{' '}
                    </>
                  )}
                  next in {tickIn}s
                </div>
                <div className="pool-tick pool-tick--tickets">
                  <PixelIcon name="ticket" size={11} />{' '}
                  {tix(props.playerTickets + props.aiTickets)} tickets in game
                </div>
              </div>
            </div>
            <div className="treasury-report">
              <div className="treasury-report-head">
                <span className="card-label">WEEKLY REPORT</span>
                <span className="card-label">WEEK {props.weekNumber}</span>
              </div>
              <div className="week-bars" aria-hidden>
                {(['prev', 'cur', 'next'] as const).map((wk) => (
                  <div key={wk} className={`week-bars-group week-bars-group--${wk}`}>
                    <div className="week-bars-cols">
                      {bars
                        .filter((b) => b.week === wk)
                        .map((b) => (
                          <span key={b.day} className={`week-bar week-bar--${b.kind}`}>
                            <i
                              key={b.kind === 'today' ? props.nextTickAt : undefined}
                              className={b.kind === 'today' && props.lastPoolAdd > 0 ? 'is-flash' : undefined}
                              style={{ height: `${Math.max(5, (b.value / barMax) * 100)}%` }}
                            />
                          </span>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <div className="action-row">
            <button type="button" className="card action-tile" onClick={() => setMode('play')}>
              <PixelIcon name="swords" size={72} />
              <span className="action-title">PLAY</span>
            </button>
            <button type="button" className="card action-tile" onClick={() => setMode('create')}>
              <img src={assetUrl('/dungeon-icon.png')} alt="Dungeon" className="action-tile-icon" />
              <span className="action-title">CREATE DUNGEON</span>
            </button>
          </div>

          <button type="button" className="card my-dungeons-tile" onClick={props.onMyDungeons}>
            <PixelIcon name="tomb" size={40} />
            <div className="my-dungeons-info">
              <div className="action-title">
                MY DUNGEONS
                <span className="count-badge" title="Live dungeons">
                  {ownedLive.length}
                </span>
              </div>
              {portfolio.profitPct > 0.5 && (
                <div className="my-dungeons-metrics">
                  <span>
                    <PixelIcon name="trend" size={12} /> PROFIT{' '}
                    <strong className="txt-win">+{portfolio.profitPct.toFixed(0)}%</strong>
                  </span>
                </div>
              )}
            </div>
            <span className="tile-arrow">→</span>
          </button>
        </main>

        <aside className="menu-right">
          <button type="button" className="card history-card" onClick={props.onHistory}>
            <span className="action-title">HISTORY</span>
            <span className="tile-arrow history-arrow">→</span>
          </button>
          <section className="card mascot-card" aria-hidden>
            <img src={assetUrl('/sprites/friend.png')} alt="" className="mascot" />
          </section>
        </aside>
      </div>

      <footer className="site-footer">
        Created by
        <a href="https://x.com/0xCephal" target="_blank" rel="noopener noreferrer">
          @0xCephal
        </a>
      </footer>

      {mode !== 'home' && (
        <TierChooser
          mode={mode}
          soft={soft}
          hard={hard}
          softEntryCost={props.softEntryCost}
          hardEntryCost={props.hardEntryCost}
          hardEntryMul={props.hardEntryMul}
          ownedLive={ownedLive.length}
          balance={wallet.balance}
          onBack={() => setMode('home')}
          onPick={(tier) => (mode === 'play' ? props.onPlay(tier) : props.onCreate(tier))}
        />
      )}

      {info === 'deposit' && (
        <div className="info-overlay" role="dialog" onClick={() => setInfo(null)}>
          <div className="card info-card" onClick={(e) => e.stopPropagation()}>
            <div className="info-card-head">
              <span className="action-title">DEPOSIT</span>
              <button type="button" className="ghost" onClick={() => setInfo(null)}>✕</button>
            </div>
            <p className="muted" style={{ margin: '12px 0' }}>
              On-chain deposits are coming soon. For now the internal wallet starts with a demo balance you can use to play and create dungeons.
            </p>
            <button type="button" className="ghost" onClick={() => setInfo(null)}>Close</button>
          </div>
        </div>
      )}

      {info && info !== 'deposit' && <InfoOverlay kind={info} onClose={() => setInfo(null)} />}
    </div>
  )
}

function TierChooser(p: {
  mode: 'play' | 'create'
  soft: TierLiveStats
  hard: TierLiveStats
  softEntryCost: number
  hardEntryCost: number
  hardEntryMul: number
  ownedLive: number
  balance: number
  onBack: () => void
  onPick: (tier: DungeonTier) => void
})  {
  const play = p.mode === 'play'
  const full = !play && p.ownedLive >= 3
  const cost = (tier: DungeonTier) =>
    play ? (tier === 'hard' ? p.hardEntryCost : p.softEntryCost) : tier === 'hard' ? HARD.createCost : SOFT.createCost

  const onBackRef = useRef(p.onBack)
  onBackRef.current = p.onBack
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBackRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="tier-overlay" role="dialog" aria-label={play ? 'Choose dungeon to play' : 'Choose dungeon to create'} onClick={p.onBack}>
      <div className="tier-overlay-title">
        <span className="action-title">{play ? 'PLAY — CHOOSE DUNGEON' : 'CREATE — CHOOSE DUNGEON'}</span>
        <span className="card-sub">Esc to close</span>
      </div>
      <div className="tier-overlay-cards">
        {(['soft', 'hard'] as const).map((tier) => {
          const st = tier === 'hard' ? p.hard : p.soft
          const price = cost(tier)
          const broke = p.balance < price
          return (
            <div key={tier} className="tier-overlay-half">
              <button
                type="button"
                className={`card tier-card tier-card--${tier}`}
                disabled={full || broke}
                onClick={(e) => {
                  e.stopPropagation()
                  p.onPick(tier)
                }}
              >
                {/* Ticket-stub layout: 75% body | dotted | 25% price notch — matches ref */}
                <div className="tier-card-ticket">
                  <div className="tier-card-ticket-body">
                    {/* Header: big X icon + name */}
                    <div className="tier-card-head">
                      <span className="tier-card-x-icon">✕</span>
                      <div className="action-title">{tier === 'hard' ? 'HARD' : 'SIMPLE'}</div>
                    </div>
                    {/* Slogan */}
                    <div className="tier-card-badge">
                      {tier === 'hard'
                        ? (play
                          ? 'fat pot · rerolls · tickets'
                          : 'fat pot · tickets · stamina drops each floor')
                        : (play ? 'cheap · frequent wins' : 'cheap · no tax · no tickets')}
                    </div>
                    {/* AVG / BEST — big pixel numbers */}
                    <div className="tier-card-wins">
                      <div className="tier-card-win-row">
                        <span className="tier-card-win-label">AVG WIN NOW</span>
                        <strong className="tier-card-win-val tier-card-win-val--hover">{mult(st.avgX)}</strong>
                      </div>
                      <div className="tier-card-win-row">
                        <span className="tier-card-win-label">BEST WIN NOW</span>
                        <strong className="tier-card-win-val tier-card-win-val--hover">{mult(st.bestX)}</strong>
                      </div>
                      {/* Create-only extras */}
                      {!play && tier === 'hard' && (
                        <>
                          <div className="tier-card-win-row">
                            <span className="tier-card-win-label" title="Rerolls change your dungeon perks — makes raiders more likely to die">REROLL ⓘ</span>
                            <strong className="tier-card-win-val">${HARD.rerollBase} ×{HARD.rerollGrowth}</strong>
                          </div>
                          <div className="tier-card-win-row tier-card-win-row--tax">
                            <span className="tier-card-win-label">TAXES UNTIL</span>
                            <strong className="tier-card-win-val">LVL 7</strong>
                          </div>
                          <div className="tier-card-win-row">
                            <span className="tier-card-win-label">TICKETS</span>
                            <strong className="tier-card-win-val">% OF POOL</strong>
                          </div>
                        </>
                      )}
                      {!play && tier === 'soft' && (
                        <div className="tier-card-win-row">
                          <span className="tier-card-win-label">TAX / TICKETS</span>
                          <strong className="tier-card-win-val">NONE</strong>
                        </div>
                      )}
                      {/* Play-only: tickets note for Hard */}
                      {play && tier === 'hard' && (
                        <div className="tier-card-win-row tier-card-win-row--ticket-note">
                          <span className="tier-card-win-label">🎟 WIN TICKETS</span>
                          <strong className="tier-card-win-val">+POOL %</strong>
                        </div>
                      )}
                    </div>
                    {/* CTA */}
                    <div className="tier-card-cta">
                      {full
                        ? 'MAX 3 LIVE DUNGEONS'
                        : broke
                          ? `NEED ${money(price)}`
                          : `${play ? 'PLAY' : 'CREATE'} ${tier === 'hard' ? 'HARD' : 'SIMPLE'} →`}
                    </div>
                  </div>
                  <div className="tier-card-ticket-stub">
                    <div
                      className={`tier-card-stub-price tier-card-stub-price--len${Math.min(6, money(price, price % 1 ? 2 : 0).length)}`}
                    >
                      {money(price, price % 1 ? 2 : 0)}
                    </div>
                    <div className="tier-card-stub-label">{play ? 'entry' : 'create'}</div>
                  </div>
                </div>
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function InfoOverlay({ kind, onClose }: { kind: 'how' | 'economy'; onClose: () => void }) {
  return (
    <div className="info-overlay" role="dialog" onClick={onClose}>
      <div
        className={`card info-card${kind === 'economy' ? ' info-card--article' : ' info-card--how'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="info-card-head">
          <span className="action-title">{kind === 'how' ? 'HOW TO PLAY' : 'ECONOMY'}</span>
          <button type="button" className="ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        {kind === 'economy' ? (
          <iframe
            className="info-article-frame"
            title="Rare Dungeons — Economic Potential"
            src={assetUrl('/rare-dungeons-article.html')}
          />
        ) : (
          <div className="info-how">
            <p className="info-how-lead">First pick a mode: PLAY or CREATE DUNGEON.</p>
            <div className="info-how-cols">
              <section className="info-how-col">
                <h3>PLAY</h3>
                <p>Choose Simple or Hard.</p>
                <p>
                  Pay the entry and send your Friend through 3 floors. Each floor you pick a perk; the dungeon
                  reveals one of its perks. Clear all three and you take 95% of the bank.
                </p>
                <p>
                  <strong>Simple</strong> — about 2–3× if you clear.
                </p>
                <p>
                  <strong>Hard</strong> — about 8–10×, but you win less often. Reroll perks to raise your odds.
                  A win also pays a share of the weekly pool.
                </p>
              </section>
              <section className="info-how-col">
                <h3>CREATE</h3>
                <p>Choose Simple or Hard.</p>
                <p>
                  Pick a layout and 3 dungeon perks. Every raider who dies adds their entry to your bank. You
                  choose when to close and claim.
                </p>
                <p>
                  <strong>Simple</strong> — around 1.5× on what you put in. Don’t get too greedy: a raider can
                  take the whole bank.
                </p>
                <p>
                  <strong>Hard</strong> — about 8–10×, plus a cut of the weekly reward pool. The longer you
                  leave it open, the more you earn — and the more likely a raider clears it and takes the
                  bank. Close too early and tax eats most of it.
                </p>
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
