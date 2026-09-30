export function money(x: number, digits?: number): string {
  const d = digits ?? (Math.abs(x) >= 1000 ? 0 : 2)
  return `$${x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`
}

export function mult(x: number): string {
  return `${x >= 10 ? x.toFixed(1) : x.toFixed(2).replace(/0$/, '')}×`
}

/** Raider "your win" multiplier, same text on the reel and in the raid. */
export function winX(x: number): string {
  return `X${x.toFixed(1)}`
}

/** Ticket power: whole numbers as-is, fractions to one decimal. */
export function tix(x: number): string {
  const r = Math.round(x * 10) / 10
  return Number.isInteger(r) ? String(r) : r.toFixed(1)
}

export function pct(frac: number): string {
  return `${Math.round(frac * 100)}%`
}

export function timeAgo(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return `${h}h ago`
}
