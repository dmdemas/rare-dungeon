import { HARD, SOFT, claimTaxFrac, projectYieldAfterRaids, ticketMintAtWin, type DungeonTier } from '../game/economy'
import { money, pct, tix } from './ui/format'

/** Any stop point from 1 to 25 survived raids. */
const MAX_PLAN = 25
const OPTIONS = Array.from({ length: MAX_PLAN }, (_, i) => i + 1)
/** YOU GET and × keep their size up to this many raids, then grow until MAX_PLAN. */
const GROW_FROM = 7

function projectClose(tier: DungeonTier, wins: number) {
  const cfg = tier === 'hard' ? HARD : SOFT
  const p = projectYieldAfterRaids(tier, {
    bank: cfg.createToBank,
    wins: 0,
    invested: cfg.createCost,
    extraRaids: wins,
  })
  let tickets = 0
  if (tier === 'hard') for (let w = 1; w <= wins; w++) tickets += ticketMintAtWin(w)
  return { ...p, tickets, tax: tier === 'hard' ? claimTaxFrac(wins) : 0 }
}

/** Hard: first tax-free win. Simple: first win at the suggested close ROI. */
export function defaultCloseAt(tier: DungeonTier): number {
  if (tier === 'hard') return 8
  return OPTIONS.find((w) => projectClose('soft', w).ownerRoi >= SOFT.suggestedCloseRoi) ?? 2
}

export function ClosePlan({
  tier,
  value,
  onChange,
  ticketUsd,
}: {
  tier: DungeonTier
  /** null = no stop point: stays live until claimed or cleared. */
  value: number | null
  onChange: (v: number | null) => void
  ticketUsd?: (tickets: number) => number
}) {
  const options = OPTIONS.map((w) => ({ w, p: projectClose(tier, w) }))
  const maxRoi = Math.max(...options.map((o) => o.p.ownerRoi))
  const sel = value != null ? projectClose(tier, value) : null

  return (
    <section className="card close-plan">
      <div className="close-plan-head">
        <span className="card-label">CLOSE PLAN — AFTER HOW MANY RAIDS DOES YOUR DUNGEON STOP?</span>
        <span className="card-sub">
          <i className="close-plan-key close-plan-key--roi" /> ROI
          {tier === 'hard' && (
            <>
              {' '}
              <i className="close-plan-key close-plan-key--tax" /> CLAIM TAX
            </>
          )}{' '}
          · then Claim or Extend in My Dungeons
        </span>
      </div>
      <div className="close-plan-body">
        <div className="close-plan-bars" role="radiogroup" aria-label="Stop after raids">
          {options.map(({ w, p }) => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={value === w}
              className={`close-plan-bar${value === w ? ' is-sel' : ''}`}
              onClick={() => onChange(w)}
              title={`${w} raids · ${p.ownerRoi.toFixed(2)}×${p.tax > 0 ? ` · tax ${pct(p.tax)}` : ''}`}
            >
              <span className="close-plan-col">
                {p.tax > 0 && <b style={{ height: `${p.tax * 100}%` }} />}
                <i style={{ height: `${Math.max(4, (p.ownerRoi / maxRoi) * 100)}%` }} />
              </span>
              <span className="close-plan-w">{w % 5 === 0 || w === 1 ? w : ''}</span>
            </button>
          ))}
          <button
            type="button"
            role="radio"
            aria-checked={value == null}
            className={`close-plan-bar close-plan-bar--manual${value == null ? ' is-sel' : ''}`}
            onClick={() => onChange(null)}
          >
            <span className="close-plan-col close-plan-col--manual">MAX</span>
            <span className="close-plan-w">25</span>
          </button>
        </div>

        {sel && value != null ? (
          <YieldDash
            tier={tier}
            youGet={sel.ownerPayout}
            invested={(tier === 'hard' ? HARD : SOFT).createCost}
            taxFrac={sel.tax}
            raidsKey="STOP AFTER"
            raids={value}
            tickets={sel.tickets}
            ticketsUsd={ticketUsd?.(sel.tickets)}
          />
        ) : (
          <p className="card-sub close-plan-manual">
            Up to 25 raids — no automatic stop. The dungeon stays live until you claim it in My Dungeons or a raider clears it.
          </p>
        )}
      </div>
    </section>
  )
}

/**
 * YOU GET · × on what you put in (the × grows with the raid count) / raids · tickets.
 * Shared by the create close plan and each live card in My Dungeons.
 */
export function YieldDash({
  tier,
  youGet,
  invested,
  taxFrac,
  raidsKey,
  raids,
  raidsSub,
  raidsHint,
  tickets,
  ticketsUsd,
}: {
  tier: DungeonTier
  youGet: number
  invested: number
  taxFrac: number
  raidsKey: string
  raids: number
  raidsSub?: string
  /** Hover text for the raids cell. */
  raidsHint?: string
  tickets: number
  /** Current $ share of the weekly pool for these tickets. */
  ticketsUsd?: number
}) {
  const roi = invested > 0 ? youGet / invested : 0
  const loss = youGet < invested - 1e-9
  const growth = Math.round((roi - 1) * 100)
  // Base size is 20% bigger; grows further from level 8 to 25.
  const BASE_GET = 22
  const BASE_X = 24
  const grow = Math.min(1, Math.max(0, (raids - GROW_FROM) / (MAX_PLAN - GROW_FROM)))
  return (
    <div className="yield-dash">
      <div className="yield-dash-cell yield-dash-get">
        <span className="owned-stat-k">YOU GET</span>
        <strong className={loss ? 'txt-loss' : 'txt-win'} style={{ fontSize: BASE_GET + 18 * grow }}>
          {money(youGet)}
          {loss && <span className="yield-dash-minus"> (−{money(invested - youGet)})</span>}
        </strong>
        <span className="owned-stat-sub">{taxFrac > 0 ? `after ${pct(taxFrac)} claim tax` : 'no claim tax'}</span>
      </div>
      <div
        className="yield-dash-cell yield-dash-x has-hint"
        data-hint="× = payout / invested. Ticket value not included — it changes throughout the week."
      >
        <strong className={loss ? 'txt-loss' : 'txt-win'} style={{ fontSize: BASE_X + 18 * grow }}>
          {roi.toFixed(2)}×
        </strong>
        <span className={`yield-dash-growth ${loss ? 'txt-loss' : 'txt-win'}`}>
          ({growth >= 0 ? '+' : ''}
          {growth}%)
        </span>
      </div>
      <div className={`yield-dash-cell${raidsHint ? ' has-hint' : ''}`} data-hint={raidsHint}>
        <span className="owned-stat-k">{raidsKey}</span>
        <strong>
          {raids} {raids === 1 ? 'raid' : 'raids'}
        </strong>
        {raidsSub && <span className="owned-stat-sub">{raidsSub}</span>}
      </div>
      {tier === 'hard' && (
        <div className="yield-dash-cell">
          <span className="owned-stat-k">TICKETS</span>
          <strong>
            {tix(tickets)}
            {ticketsUsd != null && <span className="yield-dash-tix-usd"> (≈{money(ticketsUsd, 2)})</span>}
          </strong>
          <span className="owned-stat-sub">share of the weekly pool now</span>
        </div>
      )}
    </div>
  )
}
