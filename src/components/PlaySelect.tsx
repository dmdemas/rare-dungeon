import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DungeonBlueprint } from '../game/types'
import { MapPreview } from './MapPreview'

type Props = {
  /** Hidden raid pool (not shown as a list). */
  pool: DungeonBlueprint[]
  onSelect: (bp: DungeonBlueprint) => void
  onBack: () => void
}

/** Hold on the landed dungeon, then enter it. */
const LANDED_HOLD_MS = 1000
/** Fixed card height — must match CSS `.fortune-item`. */
const ITEM_H = 168
const WINDOW_H = ITEM_H * 3
const SPIN_MS = 2700
const LOOPS = 10

function easeOutQuint(t: number) {
  return 1 - Math.pow(1 - t, 5)
}

export function PlaySelect({ pool, onSelect, onBack }: Props) {
  const [offsetY, setOffsetY] = useState(0)
  const [spinning, setSpinning] = useState(true)
  const [landedId, setLandedId] = useState<string | null>(null)
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const skipRef = useRef<(() => void) | null>(null)

  const poolKey = pool.map((p) => p.id).join('|')

  const reel = useMemo(() => {
    if (pool.length === 0) return [] as DungeonBlueprint[]
    const out: DungeonBlueprint[] = []
    for (let r = 0; r < LOOPS + 4; r++) {
      for (const bp of pool) out.push(bp)
    }
    return out
  }, [pool])

  // Only mount a few map cards around the viewport (keep spin smooth)
  const visible = useMemo(() => {
    const first = Math.max(0, Math.floor(-offsetY / ITEM_H) - 1)
    const last = Math.min(reel.length, first + 6)
    const slice: { bp: DungeonBlueprint; index: number }[] = []
    for (let i = first; i < last; i++) {
      slice.push({ bp: reel[i]!, index: i })
    }
    return slice
  }, [offsetY, reel])

  // The reel starts as soon as the mode is picked and enters the landed dungeon by itself.
  useEffect(() => {
    if (pool.length === 0) return

    const winnerIndex = Math.floor(Math.random() * pool.length)
    const winner = pool[winnerIndex]!
    const targetSlot = LOOPS * pool.length + winnerIndex
    const centerY = (WINDOW_H - ITEM_H) / 2
    const endY = -(targetSlot * ITEM_H - centerY)

    let raf = 0
    let enterTimer = 0
    const t0 = performance.now()
    setSpinning(true)
    setLandedId(null)
    setOffsetY(0)

    const tick = (now: number) => {
      const u = Math.min(1, (now - t0) / SPIN_MS)
      setOffsetY(endY * easeOutQuint(u))
      if (u < 1) {
        raf = window.requestAnimationFrame(tick)
        return
      }
      setOffsetY(endY)
      setSpinning(false)
      setLandedId(winner.id)
      enterTimer = window.setTimeout(() => onSelectRef.current(winner), LANDED_HOLD_MS)
    }

    // Skip: jump straight to the winner
    skipRef.current = () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(enterTimer)
      setOffsetY(endY)
      setSpinning(false)
      setLandedId(winner.id)
      onSelectRef.current(winner)
    }

    raf = window.requestAnimationFrame(tick)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(enterTimer)
      skipRef.current = null
    }
  }, [poolKey])

  const handleSkipKey = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      skipRef.current?.()
    }
  }, [])

  useEffect(() => {
    window.addEventListener('keydown', handleSkipKey)
    return () => window.removeEventListener('keydown', handleSkipKey)
  }, [handleSkipKey])

  if (pool.length === 0) {
    return (
      <div className="screen play-screen play-spin-screen">
        <header className="screen-header">
          <button type="button" className="ghost" onClick={onBack}>
            ← Back
          </button>
          <h1>Play</h1>
        </header>
        <p className="muted">No dungeons in the pool — return to menu.</p>
      </div>
    )
  }

  return (
    <div className="screen play-screen play-spin-screen">
      <div className="play-spin-label">{spinning ? 'SPINNING…' : '\u00a0'}</div>
      <div className="fortune-stage">
        <div className="fortune-wheel" role="img" aria-label="Dungeon reel">
          <div className="fortune-window" style={{ height: WINDOW_H }}>
            <div
              className="fortune-reel"
              style={{
                height: reel.length * ITEM_H,
                transform: `translateY(${offsetY}px)`,
              }}
            >
              {visible.map(({ bp, index }) => (
                <div
                  key={`${bp.id}-${index}`}
                  className={`fortune-item${landedId === bp.id && !spinning ? ' is-landed' : ''}`}
                  style={{
                    height: ITEM_H,
                    top: index * ITEM_H,
                  }}
                >
                  <div className="fortune-slot">
                    <MapPreview blueprint={bp} compact fogOfWar mobsAsDots />
                  </div>
                </div>
              ))}
            </div>
            <div
              className="fortune-pointer"
              style={{ height: ITEM_H, marginTop: -ITEM_H / 2 }}
              aria-hidden
            />
          </div>
        </div>
      </div>
    </div>
  )
}
