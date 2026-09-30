import { useEffect, useState } from 'react'

/** Wall clock that re-renders every `periodMs`. */
export function useNow(periodMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), periodMs)
    return () => clearInterval(t)
  }, [periodMs])
  return now
}
