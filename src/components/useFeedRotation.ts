import { useEffect, useRef } from 'react'
import type { GameEvent } from '../game/world'

/**
 * Calls `onShow` every base..base+jitter ms: the oldest not-yet-shown event if
 * one arrived, otherwise already-seen events in a loop, newest first. Events
 * present at mount count as already seen.
 */
export function useFeedRotation(
  events: GameEvent[],
  baseMs: number,
  jitterMs: number,
  onShow: (ev: GameEvent) => void,
  showFirstImmediately = false,
): void {
  const eventsRef = useRef(events)
  eventsRef.current = events
  const onShowRef = useRef(onShow)
  onShowRef.current = onShow
  const seenRef = useRef(events.length)
  const loopRef = useRef(0)

  useEffect(() => {
    const showNext = () => {
      const evs = eventsRef.current
      if (evs.length === 0) return
      if (seenRef.current < evs.length) {
        onShowRef.current(evs[seenRef.current++]!)
        return
      }
      const seen = seenRef.current
      onShowRef.current(evs[seen - 1 - (loopRef.current++ % seen)]!)
    }
    if (showFirstImmediately) showNext()
    let timer: ReturnType<typeof setTimeout>
    const schedule = () => {
      timer = setTimeout(() => {
        showNext()
        schedule()
      }, baseMs + Math.random() * jitterMs)
    }
    schedule()
    return () => clearTimeout(timer)
  }, [baseMs, jitterMs, showFirstImmediately])
}
