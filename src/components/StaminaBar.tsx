import { useEffect, useRef, useState } from 'react'
import type { RaidState } from '../game/types'

type Props = {
  raid: RaidState
  friendHurt: boolean
}

const DISPLAY_CUBES = 20

let uidCounter = 0

export function StaminaBar({ raid, friendHurt }: Props) {
  const max = raid.floorBaseStamina + raid.perkMods.staminaBonus
  const cur = Math.max(0, Math.min(max, raid.friend.stamina))

  const prevCurRef  = useRef(cur)
  const prevFloor   = useRef(raid.floor)
  const hurtRef     = useRef(friendHurt)
  hurtRef.current   = friendHurt

  // uid → index of the dying cube
  const [dying, setDying]         = useState<{ uid: number; index: number }[]>([])
  const [counterRed, setCounter]  = useState(false)

  // Floor change — reset
  useEffect(() => {
    if (prevFloor.current === raid.floor) return
    prevFloor.current  = raid.floor
    prevCurRef.current = cur
    setDying([])
    setCounter(false)
  }, [raid.floor, cur])

  // Stamina changed
  useEffect(() => {
    if (prevFloor.current !== raid.floor) return

    const prev = prevCurRef.current
    prevCurRef.current = cur

    if (cur < prev && hurtRef.current) {
      // Damage — show red cube at the index that was lost
      const idx   = Math.min(prev - 1, DISPLAY_CUBES - 1)
      const uid   = uidCounter++
      setDying((d) => [...d, { uid, index: idx }])
      setCounter(true)
      const t1 = setTimeout(() => setDying((d) => d.filter((c) => c.uid !== uid)), 700)
      const t2 = setTimeout(() => setCounter(false), 500)
      return () => { clearTimeout(t1); clearTimeout(t2) }
    }
  }, [cur, raid.floor])

  // How many cubes to show as filled (capped at DISPLAY_CUBES)
  const filled = Math.min(cur, DISPLAY_CUBES)

  return (
    <div className="stamina-bar" aria-label={`STA ${cur}/${max}`}>
      <div className="stamina-cubes">
        {Array.from({ length: DISPLAY_CUBES }, (_, i) => {
          const ghost = dying.find((d) => d.index === i)
          // Always render the base slot (filled or empty outline).
          // Dying cube is an absolute overlay so the empty slot stays visible.
          return (
            <div key={i} className="stamina-cube-slot">
              <div className={`stamina-cube ${i < filled ? 'stamina-cube--white' : 'stamina-cube--empty'}`} />
              {ghost && (
                <div
                  key={`g${ghost.uid}`}
                  className="stamina-cube stamina-cube--dying stamina-cube--damage"
                />
              )}
            </div>
          )
        })}
      </div>
      <div className={`stamina-count${counterRed ? ' stamina-count--hit' : ''}`}>
        {cur}
        {max > DISPLAY_CUBES && (
          <span className="stamina-count-max"> /{max}</span>
        )}
      </div>
    </div>
  )
}
