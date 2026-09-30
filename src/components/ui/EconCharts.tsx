import { claimTaxFrac, ticketMintAtWin } from '../../game/economy'

const TAX_WINS = [0, 1, 2, 3, 4, 5, 6, 7, 8]

/** Hard near-lock claim tax by wins; `wins` highlights the current column. */
export function TaxCurve({ wins, compact = false }: { wins?: number; compact?: boolean }) {
  return (
    <div className={`econ-chart${compact ? ' econ-chart--compact' : ''}`}>
      <div className="econ-chart-title">CLAIM TAX BY WINS</div>
      <div className="econ-bars">
        {TAX_WINS.map((w) => {
          const tax = claimTaxFrac(w)
          const cur = wins !== undefined && Math.min(8, wins) === w
          return (
            <div key={w} className={`econ-bar-col${cur ? ' is-current' : ''}`}>
              <span className="econ-bar-val">{Math.round(tax * 100)}</span>
              <i className="econ-bar econ-bar--tax" style={{ height: `${Math.max(3, tax * 100)}%` }} />
              <span className="econ-bar-x">{w === 8 ? '8+' : w}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

const MINT_WINS = [7, 8, 9, 10, 12, 14, 16, 18, 20, 22, 25]

/** Tickets minted per survived raid at a win level (Hard). */
export function TicketSchedule({ wins, compact = false }: { wins?: number; compact?: boolean }) {
  const max = ticketMintAtWin(25)
  return (
    <div className={`econ-chart${compact ? ' econ-chart--compact' : ''}`}>
      <div className="econ-chart-title">TICKETS PER WIN</div>
      <div className="econ-bars">
        {MINT_WINS.map((w, i) => {
          const t = ticketMintAtWin(w)
          const next = MINT_WINS[i + 1] ?? Infinity
          const cur = wins !== undefined && wins + 1 >= w && wins + 1 < next
          return (
            <div key={w} className={`econ-bar-col${cur ? ' is-current' : ''}`}>
              <span className="econ-bar-val">{t}</span>
              <i
                className="econ-bar econ-bar--ticket"
                style={{ height: `${Math.max(4, Math.sqrt(t / max) * 100)}%` }}
              />
              <span className="econ-bar-x">{w === 25 ? '25+' : w}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
