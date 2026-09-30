import { useEffect, useRef, useState } from 'react'
import { BASE_STAMINA, DASH_JUMP_MS, DASH_THINK_MS, JUMP_MS, THINK_MS, lowStaminaTickFactor } from '../game/config'
import { isCurrentlyVisible } from '../game/fog'
import {
  apply,
  createEmptyPerksState,
  plannedLoadoutFromRanks,
  revealDungeonPick,
  rollFriendOffer,
  rollPredefinedDungeonPerks,
  selectFriendPerk,
  syncRaidWithPerks,
  type FriendPerkId,
  type PerkOffer,
  type PerksState,
  type PlannedDungeonLoadout,
} from '../game/perks'
import { mulberry32 } from '../game/rng'
import { advanceFloor, stepAhead } from '../game/raid'
import type { Cell, DungeonBlueprint, RaidState } from '../game/types'
import { DungeonCanvas, type DashTrailCell, type JumpAnim } from './DungeonCanvas'
import { PerkOfferOverlay } from './perks/PerkOfferOverlay'
import { PerkSlotsBar } from './perks/PerkSlotsBar'
import { StaminaBar } from './StaminaBar'
import { RewardDashboard } from './RewardDashboard'
import { HARD, SOFT } from '../game/economy'
/** 3 = Skip: bot picks perks and the raid fast-forwards to its result. */
type Speed = 0 | 1 | 2 | 3
const SKIP: Speed = 3
const SPEED_SCALE: Record<Speed, number> = { 0: 1, 1: 1, 2: 0.5, 3: 0.04 }
type ClockPhase = 'intro' | 'perks' | 'think' | 'jump'

type Props = {
  raid: RaidState
  blueprint: DungeonBlueprint
  /** Entry paid for this raid — "your win ×" is measured against it. */
  entryPaid?: number
  /** $ these tickets would take from the reward pool now (Hard dashboard). */
  ticketUsd?: (tickets: number) => number
  onRaidChange: (r: RaidState) => void
  onOutcome: (result: 'won' | 'dead' | 'surrendered', floor: number) => void
  /** Hard Friend offer reroll: pay next ladder step → pool. Soft = omit. */
  offerReroll?: {
    walletBalance: number
    nextCost: (already: number) => number
    tryPay: (already: number) => boolean
  } | null
}

export function RaidView({
  raid,
  blueprint,
  ticketUsd,
  entryPaid,
  onRaidChange,
  onOutcome,
  offerReroll = null,
}: Props) {
  const isGridDemo = !!blueprint.isGridDemo
  const pitCliffStyle = blueprint.pitCliffStyle ?? 4
  const [speed, setSpeed] = useState<Speed>(1)
  const speedRef = useRef(speed)
  speedRef.current = speed
  const skipping = speed === SKIP
  const [clock, setClock] = useState<ClockPhase>('intro')
  const [boardOpacity, setBoardOpacity] = useState(0)
  const [overlayOpacity, setOverlayOpacity] = useState(0)
  const [introKey, setIntroKey] = useState(0)
  const [highlights, setHighlights] = useState<Cell[]>([])
  const [jumpAnim, setJumpAnim] = useState<JumpAnim | null>(null)
  const [friendHurt, setFriendHurt] = useState(false)
  const [hurtMobId, setHurtMobId] = useState<number | null>(null)
  const [dashTrail, setDashTrail] = useState<DashTrailCell[]>([])
  const [enduranceShield, setEnduranceShield] = useState(false)
  const [enduranceBreakT, setEnduranceBreakT] = useState(0)
  const [enduranceBreakKey, setEnduranceBreakKey] = useState(0)
  const friendHurtTimer = useRef(0)
  const dashTrailRef = useRef<DashTrailCell[]>([])
  const jumpAnimRef = useRef<JumpAnim | null>(null)
  const enduranceAboveRef = useRef(false)

  const [perks, setPerks] = useState<PerksState>(() => createEmptyPerksState())
  /** Creator loadout — rolled once per raid for test; revealed as Friend powers up. */
  const [plannedDungeon, setPlannedDungeon] = useState<PlannedDungeonLoadout>({ picks: [] })
  const [friendOffer, setFriendOffer] = useState<PerkOffer<FriendPerkId> | null>(null)
  /** Rerolls used on the current Friend offer (reset each floor / new offer). */
  const [offerRerolls, setOfferRerolls] = useState(0)

  const raidRef = useRef(raid)
  const blueprintRef = useRef(blueprint)
  const onRaidChangeRef = useRef(onRaidChange)
  const onOutcomeRef = useRef(onOutcome)
  const pendingRef = useRef<RaidState | null>(null)
  const beforeJumpRef = useRef<RaidState | null>(null)
  const hurtFlashSeen = useRef(0)
  const rallyFlashSeen = useRef(0)
  const perksRef = useRef(perks)
  const [rallyBurstId, setRallyBurstId] = useState(0)
  const [rallyFlags, setRallyFlags] = useState<Cell[]>([])
  const [dodgeBurstId, setDodgeBurstId] = useState(0)
  const dodgeFlashSeen = useRef(0)
  const [clawsBurstId, setClawsBurstId] = useState(0)
  const clawsFlashSeen = useRef(0)

  raidRef.current = raid
  blueprintRef.current = blueprint
  onRaidChangeRef.current = onRaidChange
  onOutcomeRef.current = onOutcome
  perksRef.current = perks
  jumpAnimRef.current = jumpAnim

  // New raid → Friend slots / dungeon loadout (prefer Create bake)
  useEffect(() => {
    if (isGridDemo) return
    const baked = blueprint.dungeonPerks
    const planned =
      baked && baked.slots.some(Boolean)
        ? plannedLoadoutFromRanks(baked.slots, baked.ranks as Record<string, 1 | 2 | 3>)
        : rollPredefinedDungeonPerks(mulberry32((Math.random() * 0x100000000) >>> 0), blueprint.isCorridor ?? false)
    setPlannedDungeon(planned)
    setPerks(createEmptyPerksState())
    setOfferRerolls(0) // Hard reroll ladder resets only for a new dungeon raid
  }, [raid.dungeonId, isGridDemo, blueprint.dungeonPerks])

  // Esc asks before leaving (the entry is lost); the raid is paused while asking.
  const [confirmExit, setConfirmExit] = useState(false)
  const speedBeforeExitRef = useRef<Speed>(1)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isGridDemo) {
        if (e.key === 'Escape') onOutcomeRef.current('surrendered', raidRef.current.floor)
        return
      }
      if (!confirmExit) {
        if (e.key !== 'Escape') return
        e.preventDefault()
        speedBeforeExitRef.current = speedRef.current
        setSpeed(0)
        setConfirmExit(true)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setConfirmExit(false)
        setSpeed(speedBeforeExitRef.current)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        onOutcomeRef.current('surrendered', raidRef.current.floor)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isGridDemo, confirmExit])

  const triggerHurtFlash = () => {
    setFriendHurt(true)
    window.clearTimeout(friendHurtTimer.current)
    friendHurtTimer.current = window.setTimeout(() => setFriendHurt(false), 1000)
  }

  useEffect(() => {
    if (raid.hurtFlash <= hurtFlashSeen.current) return
    hurtFlashSeen.current = raid.hurtFlash
    triggerHurtFlash()
  }, [raid.hurtFlash])

  useEffect(() => {
    if (raid.dodgeFlash <= dodgeFlashSeen.current) return
    dodgeFlashSeen.current = raid.dodgeFlash
    setDodgeBurstId((n) => n + 1)
  }, [raid.dodgeFlash])

  useEffect(() => {
    if (raid.clawsFlash <= clawsFlashSeen.current) return
    clawsFlashSeen.current = raid.clawsFlash
    setClawsBurstId((n) => n + 1)
  }, [raid.clawsFlash])

  useEffect(() => {
    if (raid.rallyFlash <= rallyFlashSeen.current) return
    rallyFlashSeen.current = raid.rallyFlash
    const cell = raid.lastRallyCell
    if (!cell) return
    setRallyFlags((flags) => [...flags, { x: cell.x, y: cell.y }])
    setRallyBurstId((n) => n + 1)
  }, [raid.rallyFlash, raid.lastRallyCell])

  // Fade Dash trail: cells farther than 1 from Friend dissolve
  useEffect(() => {
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(48, now - last)
      last = now
      const anim = jumpAnimRef.current
      const fx = anim?.friendTo.x ?? raidRef.current.friend.x
      const fy = anim?.friendTo.y ?? raidRef.current.friend.y
      const prev = dashTrailRef.current
      if (prev.length) {
        let changed = false
        const next: DashTrailCell[] = []
        for (const c of prev) {
          const dist = Math.abs(c.x - fx) + Math.abs(c.y - fy)
          let opacity = c.opacity
          if (dist > 1) {
            opacity = Math.max(0, opacity - dt / 280)
            changed = true
          }
          if (opacity > 0.02) next.push({ ...c, opacity })
          else changed = true
        }
        if (changed) {
          dashTrailRef.current = next
          setDashTrail(next)
        }
      }
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [])

  // Clear trail / endurance / flags each floor (flags only last one round)
  useEffect(() => {
    dashTrailRef.current = []
    setDashTrail([])
    setEnduranceShield(false)
    enduranceAboveRef.current = false
    setEnduranceBreakT(0)
    rallyFlashSeen.current = 0
    setRallyFlags([])
    dodgeFlashSeen.current = 0
    clawsFlashSeen.current = 0
  }, [raid.dungeonId, raid.floor])

  // Endurance blue ward while bonus STA remains; flash when it drops to floor base
  useEffect(() => {
    const bonus = raid.perkMods.staminaBonus
    const base = raid.floorBaseStamina ?? BASE_STAMINA
    const above = bonus > 0 && raid.friend.stamina > base
    if (above) {
      setEnduranceShield(true)
      enduranceAboveRef.current = true
      return
    }
    if (enduranceAboveRef.current && raid.friend.stamina <= base) {
      enduranceAboveRef.current = false
      setEnduranceShield(false)
      setEnduranceBreakKey((k) => k + 1)
      return
    }
    if (bonus <= 0) {
      setEnduranceShield(false)
      enduranceAboveRef.current = false
    }
  }, [raid.friend.stamina, raid.perkMods.staminaBonus, raid.floorBaseStamina])

  useEffect(() => {
    if (enduranceBreakKey <= 0) return
    let raf = 0
    const start = performance.now()
    const DUR = 420
    const tick = (now: number) => {
      const u = Math.min(1, (now - start) / DUR)
      setEnduranceBreakT(u)
      if (u < 1) raf = window.requestAnimationFrame(tick)
      else setEnduranceBreakT(0)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [enduranceBreakKey])

  // Floor intro → Friend perk pick → reveal dungeon perk → think
  useEffect(() => {
    if (isGridDemo) {
      setClock('think')
      setBoardOpacity(1)
      setOverlayOpacity(0)
      setHighlights([])
      setJumpAnim(null)
      setHurtMobId(null)
      setFriendOffer(null)
      pendingRef.current = null
      beforeJumpRef.current = null
      return
    }
    setClock('intro')
    setHighlights([])
    setJumpAnim(null)
    setHurtMobId(null)
    setFriendOffer(null)
    pendingRef.current = null
    beforeJumpRef.current = null
    setBoardOpacity(0)
    setIntroKey((k) => k + 1)

    let cancelled = false
    const timers: number[] = []
    const fadeStart = performance.now()

    const fadeBoard = () => {
      if (cancelled) return
      const t = Math.min(1, (performance.now() - fadeStart) / 400)
      setBoardOpacity(t)
      if (t < 1) timers.push(window.requestAnimationFrame(fadeBoard))
    }
    timers.push(window.requestAnimationFrame(fadeBoard))

    // Logo + round number stay visible for the whole floor
    setOverlayOpacity(1)

    timers.push(
      window.setTimeout(() => {
        if (cancelled) return
        const rng = mulberry32((Math.random() * 0x100000000) >>> 0)
        // Keep offerRerolls across floors — ladder is per raid, not per round
        const offer = rollFriendOffer(perksRef.current, rng)
        setFriendOffer(offer)
        setClock(offer ? 'perks' : 'think')
      }, speedRef.current === SKIP ? 60 : 1000),
    )

    return () => {
      cancelled = true
      for (const id of timers) {
        window.clearTimeout(id)
        window.cancelAnimationFrame(id)
      }
    }
  }, [raid.dungeonId, raid.floor, isGridDemo])

  const onPickFriend = (id: FriendPerkId) => {
    setFriendOffer(null)
    let next = selectFriendPerk(perks, id)
    const friendRank = next.friend.ranks[id]
    if (friendRank) apply(id, friendRank, { side: 'friend' })

    // Dungeon loadout already chosen — reveal matching round/slot
    const slotIndex = Math.min(2, Math.max(0, raid.floor - 1))
    next = {
      ...next,
      dungeon: revealDungeonPick(next.dungeon, plannedDungeon, slotIndex),
    }
    const revealed = plannedDungeon.picks[slotIndex]
    if (revealed) apply(revealed.id, revealed.rank, { side: 'dungeon' })

    setPerks(next)
    // Push modifiers into live raid (vision / stamina / combat)
    let synced = syncRaidWithPerks(raid, next)

    // Lock Pits onto the dungeon blueprint so later floors never re-roll them
    if (synced.wallsPerkCells.length > 0) {
      blueprint.perkPitKeys = [...synced.wallsPerkCells]
      blueprint.map = {
        tiles: [...synced.map.tiles],
        walls: new Set(synced.map.walls),
      }
      blueprint.mobSpawns = synced.mobs
        .filter((m) => m.hp > 0 && !m.fromHorde)
        .map((m) => ({ x: m.x, y: m.y }))
    }

    const extraLog: string[] = []
    if (id === 'dash' && friendRank) {
      const steps = friendRank === 1 ? 2 : friendRank === 2 ? 3 : 4
      extraLog.push(
        `[DASH] Equipped rank ${'I'.repeat(friendRank)} — after a hit: ${steps} free steps toward exit`,
      )
    }
    if (id === 'sharpEye' && friendRank) {
      const cut = friendRank === 1 ? 15 : friendRank === 2 ? 30 : 45
      extraLog.push(
        `[EYE] Equipped rank ${'I'.repeat(friendRank)} — vision +${friendRank}, flinch −${cut}%`,
      )
    }
    if (id === 'endurance' && friendRank) {
      const bonus = friendRank === 1 ? 2 : friendRank === 2 ? 3 : 4
      extraLog.push(
        `[ENDURANCE] Equipped rank ${'I'.repeat(friendRank)} — max STA +${bonus} (now ${15 + bonus})`,
      )
    }
    if (id === 'rally' && friendRank) {
      const heal = friendRank === 1 ? 1 : friendRank === 2 ? 2 : 3
      extraLog.push(
        `[RALLY] Equipped rank ${'I'.repeat(friendRank)} — on kill +${heal} STA, max 2× per floor`,
      )
    }
    if (id === 'fearless' && friendRank) {
      const cut = friendRank === 1 ? 25 : friendRank === 2 ? 50 : 75
      extraLog.push(
        `[FEARLESS] Equipped rank ${'I'.repeat(friendRank)} — flinch −${cut}% (min 0%); hop 1 if fear ≤25%, else 2`,
      )
    }
    if (id === 'dodge' && friendRank) {
      const pct = friendRank === 1 ? 35 : friendRank === 2 ? 55 : 75
      extraLog.push(
        `[DODGE] Equipped rank ${'I'.repeat(friendRank)} — ${pct}% ignore hit`,
      )
    }
    if (revealed?.id === 'fog') {
      const bonus = revealed.rank === 1 ? 15 : revealed.rank === 2 ? 30 : 45
      extraLog.push(
        `[FOG] Revealed rank ${'I'.repeat(revealed.rank)} — vision −${revealed.rank}, flinch +${bonus}%`,
      )
    }
    if (revealed?.id === 'dreadfulBeasts') {
      const bonus = revealed.rank === 1 ? 25 : revealed.rank === 2 ? 50 : 75
      extraLog.push(
        `[DREAD] Revealed rank ${'I'.repeat(revealed.rank)} — flinch +${bonus}%; hop 1 if fear ≤25%, else 2`,
      )
    }
    if (revealed?.id === 'sharpClaws') {
      const bonus = revealed.rank === 3 ? 2 : revealed.rank
      extraLog.push(
        `[CLAWS] Revealed rank ${'I'.repeat(revealed.rank)} — mob damage +${bonus}`,
      )
    }
    if (revealed?.id === 'thickHide') {
      extraLog.push(
        `[HIDE] Revealed rank ${'I'.repeat(revealed.rank)} — mob HP +${revealed.rank}`,
      )
    }
    if (revealed?.id === 'walls') {
      const n = revealed.rank === 1 ? '4–6' : revealed.rank === 2 ? '6–8' : '8–10'
      extraLog.push(`[PITS] Revealed rank ${'I'.repeat(revealed.rank)} — +${n} pits`)
    }
    if (revealed?.id === 'horde') {
      const n =
        revealed.rank === 1 ? '+1' : '2–3'
      extraLog.push(`[HORDE] Revealed rank ${'I'.repeat(revealed.rank)} — ${n} mob(s)`)
    }
    if (extraLog.length) {
      synced = { ...synced, log: [...synced.log, ...extraLog] }
    }
    onRaidChange(synced)
    setFriendOffer(null)
    setClock('think')
  }

  const onRerollFriendOffer = () => {
    if (!offerReroll || !friendOffer) return
    if (!offerReroll.tryPay(offerRerolls)) return
    const rng = mulberry32((Math.random() * 0x100000000) >>> 0)
    setFriendOffer(rollFriendOffer(perksRef.current, rng))
    setOfferRerolls((n) => n + 1)
  }

  // Think → Jump loop (blocked while picking Friend perk)
  useEffect(() => {
    if (clock !== 'think' && clock !== 'jump') return
    if (speed === 0) return

    const scale = SPEED_SCALE[speed]
    const beat = (ms: number) => (speed === SKIP ? Math.min(ms, 150) : ms)
    const dashing =
      clock === 'think'
        ? raidRef.current.dashStepsLeft > 0
        : (beforeJumpRef.current?.dashStepsLeft ?? 0) > 0
    const sta = raidRef.current.friend.stamina
    const lowSta = dashing ? 1 : lowStaminaTickFactor(sta)
    const thinkMs = (dashing ? DASH_THINK_MS : THINK_MS) * scale * lowSta
    const jumpMs = (dashing ? DASH_JUMP_MS : JUMP_MS) * scale * lowSta

    let cancelled = false
    let timer = 0
    let raf = 0

    if (clock === 'think') {
      const cur = raidRef.current
      setHurtMobId(null)
      // Floor clear / win with 0 STA is success — never treat as death
      if (cur.phase === 'floorClear' || cur.phase === 'won') return
      if (cur.phase === 'dead' || (cur.phase === 'running' && cur.friend.stamina <= 0)) {
        const dead = cur.phase === 'dead' ? cur : { ...cur, phase: 'dead' as const }
        onRaidChangeRef.current(dead)
        // Brief beat on the board, then fade outcome
        timer = window.setTimeout(() => {
          if (!cancelled) onOutcomeRef.current('dead', dead.floor)
        }, beat(700))
        return
      }
      if (cur.phase !== 'running') return
      const { next, destinations } = stepAhead(cur)
      pendingRef.current = next
      beforeJumpRef.current = cur
      if (next.hurtFlash > hurtFlashSeen.current) {
        hurtFlashSeen.current = next.hurtFlash
        triggerHurtFlash()
      }
      if (next.dodgeFlash > dodgeFlashSeen.current) {
        dodgeFlashSeen.current = next.dodgeFlash
        setDodgeBurstId((n) => n + 1)
      }
      if (next.clawsFlash > clawsFlashSeen.current) {
        clawsFlashSeen.current = next.clawsFlash
        setClawsBurstId((n) => n + 1)
      }
      for (const prev of cur.mobs) {
        if (prev.hp <= 0) continue
        const after = next.mobs.find((m) => m.id === prev.id)
        if (!after || after.hp < prev.hp) {
          setHurtMobId(prev.id)
          break
        }
      }
      const friendMoved =
        next.friend.x !== cur.friend.x || next.friend.y !== cur.friend.y
      const marks: Cell[] = []
      if (friendMoved) {
        marks.push({ x: next.friend.x, y: next.friend.y })
      }
      for (const d of destinations) {
        if (d.x === next.friend.x && d.y === next.friend.y) continue
        if (!isCurrentlyVisible(cur.friend, d.x, d.y)) continue
        marks.push(d)
      }
      setHighlights(marks)
      timer = window.setTimeout(() => {
        if (!cancelled) setClock('jump')
      }, thinkMs)
    } else {
      const before = beforeJumpRef.current
      const next = pendingRef.current
      setHighlights([])

      if (before && next) {
        const friendMoved =
          next.friend.x !== before.friend.x || next.friend.y !== before.friend.y
        // Leave purple trail on cells the Friend dashed out of
        if (friendMoved && before.dashStepsLeft > 0) {
          const cap = Math.max(2, before.perkMods.dashSteps || 2)
          const cell: DashTrailCell = {
            x: before.friend.x,
            y: before.friend.y,
            opacity: 1,
          }
          const merged = [...dashTrailRef.current, cell].slice(-cap)
          dashTrailRef.current = merged
          setDashTrail(merged)
        }

        const mobs: JumpAnim['mobs'] = []
        for (const m of next.mobs) {
          if (m.hp <= 0) continue
          const prev = before.mobs.find((b) => b.id === m.id)
          if (!prev || prev.hp <= 0) continue
          mobs.push({
            id: m.id,
            from: { x: prev.x, y: prev.y },
            to: { x: m.x, y: m.y },
          })
        }
        const anim: JumpAnim = {
          friendFrom: { x: before.friend.x, y: before.friend.y },
          friendTo: { x: next.friend.x, y: next.friend.y },
          mobs,
          t: 0,
        }
        setJumpAnim(anim)

        const finishJump = () => {
          setJumpAnim(null)
          pendingRef.current = null
          beforeJumpRef.current = null
          if (next.phase === 'floorClear') {
            if (next.floor >= 3) {
              onRaidChangeRef.current({ ...next, phase: 'won' })
              onOutcomeRef.current('won', next.floor)
              return
            }
            onRaidChangeRef.current(advanceFloor(next, blueprintRef.current))
            return
          }
          if (next.phase === 'won') {
            onRaidChangeRef.current(next)
            onOutcomeRef.current('won', next.floor)
            return
          }
          if (next.phase === 'dead') {
            // Land on the final cell, hold, then fade to “no treasure”
            onRaidChangeRef.current(next)
            timer = window.setTimeout(() => {
              if (!cancelled) onOutcomeRef.current('dead', next.floor)
            }, beat(900))
            return
          }
          onRaidChangeRef.current(next)
          timer = window.setTimeout(() => {
            if (!cancelled && raidRef.current.phase === 'running') setClock('think')
          }, 16)
        }

        const start = performance.now()
        const tickAnim = () => {
          if (cancelled) return
          const u = Math.min(1, (performance.now() - start) / jumpMs)
          setJumpAnim((a) => (a ? { ...a, t: u } : a))
          if (u < 1) {
            raf = window.requestAnimationFrame(tickAnim)
          } else {
            // Freeze one frame on the landed cell before clearing jump anim
            setJumpAnim((a) => (a ? { ...a, t: 1 } : a))
            timer = window.setTimeout(() => {
              if (!cancelled) finishJump()
            }, next.phase === 'dead' ? beat(420) : 0)
          }
        }
        raf = window.requestAnimationFrame(tickAnim)
      } else {
        timer = window.setTimeout(() => {
          if (!cancelled) setClock('think')
        }, jumpMs)
      }
    }

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.cancelAnimationFrame(raf)
    }
  }, [clock, speed])

  const floorNum = Math.min(3, Math.max(1, raid.floor))
  const paidEntry =
    entryPaid && entryPaid > 0 ? entryPaid : (blueprint.tier ?? 'soft') === 'hard' ? HARD.entryCost : SOFT.entryCost

  return (
    <div className="screen raid-screen">
      <div className="raid-stage">
        <header className="raid-hud">
          <div className="speed-controls">
            {([
              [0, 'PAUSE'],
              [1, 'X1'],
              [2, 'X2'],
            ] as const).map(([s, label]) => (
              <button
                key={s}
                type="button"
                className={speed === s ? 'active' : ''}
                onClick={() => setSpeed(s)}
              >
                {label}
              </button>
            ))}
            {isGridDemo ? (
              <button type="button" className="ghost" onClick={() => onOutcome('surrendered', raid.floor)}>
                Back (Esc)
              </button>
            ) : (
              <button
                type="button"
                className={`skip-btn${skipping ? ' active' : ''}`}
                disabled={skipping}
                title="Fast-forward the fights (you still pick your perks)"
                onClick={() => setSpeed(SKIP)}
              >
                {skipping ? 'SKIPPING…' : 'SKIP »'}
              </button>
            )}
          </div>
        </header>
        <DungeonCanvas
          raid={raid}
          highlights={highlights}
          jumpAnim={jumpAnim}
          friendHurt={friendHurt}
          hurtMobId={hurtMobId}
          dashTrail={dashTrail}
          enduranceShield={enduranceShield}
          enduranceBreakT={enduranceBreakT}
          rallyBurstId={rallyBurstId}
          rallyFlags={rallyFlags}
          dodgeBurstId={dodgeBurstId}
          clawsBurstId={clawsBurstId}
          boardOpacity={boardOpacity}
          pitCliffStyle={pitCliffStyle}
          revealAll={isGridDemo}
        />
        {!isGridDemo && (
          <div
            key={introKey}
            className="floor-intro-overlay"
            style={{ opacity: overlayOpacity }}
            aria-hidden={overlayOpacity < 0.05}
          >
            {/* Logo: "RareDungeons" name sprite */}
            <img
              src="/sprites/logo-name-sprite.png"
              alt="RareDungeons"
              className="floor-intro-logo"
            />
            {/* Floor label + number below the logo */}
            <div className="floor-intro-round">
              <img src="/sprites/floor-text.png" alt="Floor" className="floor-intro-round-label" />
              <img
                src={`/sprites/${floorNum}.png`}
                alt={`Floor ${floorNum}`}
                className="floor-intro-round-num"
              />
            </div>
          </div>
        )}
        {!isGridDemo && clock === 'perks' && friendOffer && (
          <PerkOfferOverlay
            label="Choose a Friend perk"
            side="friend"
            offer={friendOffer}
            ranks={perks.friend.ranks}
            onPick={onPickFriend}
            reroll={
              offerReroll
                ? {
                    cost: offerReroll.nextCost(offerRerolls),
                    disabled:
                      offerReroll.walletBalance < offerReroll.nextCost(offerRerolls),
                    onReroll: onRerollFriendOffer,
                  }
                : null
            }
          />
        )}
        {!isGridDemo && (
          <StaminaBar raid={raid} friendHurt={friendHurt} />
        )}
        {!isGridDemo && (
          <RewardDashboard
            className="reward-dash--raid"
            tier={blueprint.tier ?? 'soft'}
            bank={blueprint.bank ?? 0}
            tickets={blueprint.ticketPower ?? 0}
            entryPaid={paidEntry}
            ticketUsd={ticketUsd}
          />
        )}
        {!isGridDemo && (
          <PerkSlotsBar
            variant="play"
            friendSlots={perks.friend.slots}
            dungeonSlots={perks.dungeon.slots}
            friendRanks={perks.friend.ranks}
            dungeonRanks={perks.dungeon.ranks}
          />
        )}
        {confirmExit && (
          <div className="create-leave" role="alertdialog" aria-label="Leave the raid">
            <div className="card create-leave-card">
              <div className="action-title">LEAVE THE RAID?</div>
              <p className="card-sub">
                You lose your entry (<strong className="txt-loss">${paidEntry.toFixed(2)}</strong>).
              </p>
              <div className="create-leave-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setConfirmExit(false)
                    setSpeed(speedBeforeExitRef.current)
                  }}
                >
                  STAY · ESC
                </button>
                <button
                  type="button"
                  className="ghost create-leave-go"
                  onClick={() => onOutcome('surrendered', raid.floor)}
                >
                  LEAVE (−${paidEntry.toFixed(2)}) · ENTER
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
