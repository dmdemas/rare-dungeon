import {
  BASE_ATTACK,
  BASE_STAMINA,
  BASE_VISION,
  FRIEND_AVOID_MOB_P,
  FRIEND_FLINCH_MAX,
  FRIEND_FLINCH_RANGE,
  FRIEND_FLINCH_STEPS,
  FRIEND_FLINCH_STEPS_LOW,
  MOB_DAMAGE,
  MOB_HP,
  MOB_VISION,
} from './config'
import { HARD, SOFT, absoluteDungeonPowerScale, hardFloorStamina, softFloorStamina } from './economy'
import { bootstrapKnowledge, revealAround } from './fog'
import {
  getEntranceCell,
  getExitCell,
  rebuildWallSet,
  relocateOffPits,
  stampPerkPits,
} from './mapGen'
import { emptyPerkMods, friendMaxStamina, friendVision, frightChance } from './perks/effects'
import { ensureStructurePerks } from './perks/sync'
import { bfsPathForward, chebyshev, inBounds, manhattan, neighbors4, tileAt } from './pathfinding'
import { chance, mulberry32, type Rng } from './rng'
import type { Cell, DungeonBlueprint, FriendState, Mob, RaidState } from './types'
import { cellKey } from './types'

function cloneMap(bp: DungeonBlueprint) {
  return {
    tiles: [...bp.map.tiles],
    walls: new Set(bp.map.walls),
  }
}

export function startRaid(bp: DungeonBlueprint, floor = 1, raidSeed?: number): RaidState {
  const entrance = getEntranceCell(bp.map.tiles)
  const tier = bp.tier ?? 'soft'
  const floorBaseStamina = tier === 'hard' ? hardFloorStamina(floor) : softFloorStamina(floor)
  const friend: FriendState = {
    x: entrance.x,
    y: entrance.y,
    stamina: floorBaseStamina,
    attack: BASE_ATTACK,
    vision: BASE_VISION,
  }
  const map = cloneMap(bp)
  const pitKeys = bp.perkPitKeys ? [...bp.perkPitKeys] : []
  if (pitKeys.length) {
    stampPerkPits(map.tiles, pitKeys)
    map.walls = rebuildWallSet(map.tiles)
  }
  const spawnRng = mulberry32((floor * 104729 + pitKeys.length * 9973) >>> 0)
  const safeSpawns = relocateOffPits(
    map.tiles,
    bp.mobSpawns.map((s) => ({ x: s.x, y: s.y })),
    spawnRng,
  )
  const mobs: Mob[] = safeSpawns.map((s, i) => ({
    id: i + 1,
    x: s.x,
    y: s.y,
    hp: MOB_HP,
    lastDx: 0,
    lastDy: 0,
    aggro: false,
  }))
  const knowledge = bootstrapKnowledge(map, friend, mobs)
  const exit = getExitCell(bp.map.tiles)
  const perkMods = emptyPerkMods()
  return {
    dungeonId: bp.id,
    dungeonName: bp.name,
    map,
    floor,
    friend,
    mobs,
    knowledge,
    phase: 'running',
    tick: 0,
    stuckTicks: 0,
    noProgressTicks: 0,
    lastProgressDist: manhattan(friend, exit),
    recentCells: [cellKey(friend.x, friend.y)],
    log: [`Floor ${floor} start`],
    hurtFlash: 0,
    clawsFlash: 0,
    dodgeFlash: 0,
    rallyFlash: 0,
    lastRallyCell: null,
    flinchCount: 0,
    flinchCheckedIds: [],
    raidSeed: raidSeed ?? ((Math.random() * 0x100000000) >>> 0),
    perkMods,
    rallyUsedThisFloor: 0,
    dashStepsLeft: 0,
    wallsPerkPlaced: pitKeys.length,
    wallsPerkCells: pitKeys,
    hordePerkSpawned: 0,
    dungeonPowerScale: bp.dungeonPowerScale ?? absoluteDungeonPowerScale(tier),
    floorBaseStamina,
    tier,
    isCorridor: bp.isCorridor ?? false,
    mapSeed: bp.mapSeed,
    softEase:
      tier === 'soft'
        ? {
            staminaBonus: SOFT.friendStaminaBonus,
            frightCut: SOFT.friendFrightCut,
            dodgeFloor: SOFT.friendDodgeFloor,
            dungeonEfficacy: SOFT.dungeonEfficacy,
          }
        : tier === 'hard' && (HARD.friendStaminaBonus || HARD.friendFrightCut)
          ? {
              staminaBonus: HARD.friendStaminaBonus,
              frightCut: HARD.friendFrightCut,
              dodgeFloor: HARD.friendDodgeFloor,
            }
          : undefined,
  }
}

/** Melee only along corridor depth (same lane), exactly 1 cell apart. Never lateral. */
function canMeleeAttack(
  raid: RaidState,
  a: { x: number; y: number },
  b: { x: number; y: number },
): boolean {
  // Same lane only — never horizontal / diagonal
  if (a.y !== b.y) return false
  // Exactly one depth step — never through an intervening cell
  if (Math.abs(a.x - b.x) !== 1) return false
  // No hits into/out of pits or walls
  if (isWall(raid, a.x, a.y) || isWall(raid, b.x, b.y)) return false
  return true
}

/** Living mobs that can depth-melee Friend right now. */
function adjacentMobs(raid: RaidState): Mob[] {
  return raid.mobs.filter((m) => m.hp > 0 && canMeleeAttack(raid, m, raid.friend))
}

function fight(raid: RaidState, mob: Mob, rng?: Rng): void {
  // In-place attack only. Depth-adjacent only — not horizontal, not through cells.
  if (!canMeleeAttack(raid, mob, raid.friend)) return
  const roll = rng ?? mulberry32((raid.raidSeed ^ ((raid.tick + 1) * 9973) ^ (mob.id * 131)) >>> 0)
  mob.hp -= raid.friend.attack

  const mods = raid.perkMods
  const dodged = mods.dodgeChance > 0 && chance(roll, mods.dodgeChance)
  if (dodged) {
    raid.log.push(`[DODGE] Ignored mob#${mob.id} hit`)
    raid.dodgeFlash += 1
  } else {
    const dmg = MOB_DAMAGE + mods.mobDamageBonus
    raid.friend.stamina -= dmg
    raid.hurtFlash += 1
    if (mods.clawsRank > 0) raid.clawsFlash += 1
    if (mods.dashSteps > 0) {
      raid.dashStepsLeft = mods.dashSteps
      raid.log.push(`[DASH] Armed after hit — ${mods.dashSteps} free steps (no STA)`)
    }
  }

  raid.log.push(
    `Fight mob#${mob.id} (mob hp ${Math.max(0, mob.hp)}, sta ${raid.friend.stamina}${dodged ? ', dodged' : ''})`,
  )
  if (mob.hp <= 0) {
    raid.knowledge.mobs.delete(mob.id)
    mob.aggro = false
    raid.log.push(`Mob#${mob.id} slain`)
    // Rally: restore stamina on kill (capped procs per floor)
    if (mods.rallyHeal > 0) {
      const capped =
        mods.rallyFloorCap != null && raid.rallyUsedThisFloor >= mods.rallyFloorCap
      if (!capped) {
        const maxSta = friendMaxStamina(mods, raid.floorBaseStamina ?? BASE_STAMINA)
        const before = raid.friend.stamina
        const gained = Math.min(mods.rallyHeal, Math.max(0, maxSta - before))
        if (gained > 0) {
          raid.friend.stamina = before + gained
          raid.rallyUsedThisFloor += 1
          raid.rallyFlash += 1
          raid.lastRallyCell = { x: mob.x, y: mob.y }
          raid.log.push(
            `[RALLY] +${gained} STA on kill (used ${raid.rallyUsedThisFloor}${mods.rallyFloorCap != null ? `/${mods.rallyFloorCap}` : ''} this floor)`,
          )
        }
      }
    }
  }
  if (raid.friend.stamina <= 0) {
    raid.phase = 'dead'
    raid.log.push('Friend fallen')
  }
}

function livingMobAt(raid: RaidState, x: number, y: number): Mob | undefined {
  return raid.mobs.find((m) => m.hp > 0 && m.x === x && m.y === y)
}

function isWall(raid: RaidState, x: number, y: number): boolean {
  if (!inBounds(x, y)) return true
  return tileAt(raid.map.tiles, x, y) === 'wall'
}

/** Cell Friend may occupy: on-map, not a pit/wall. */
function friendCanStand(raid: RaidState, x: number, y: number): boolean {
  if (!inBounds(x, y)) return false
  const kind = tileAt(raid.map.tiles, x, y)
  return kind === 'floor' || kind === 'entrance' || kind === 'exit'
}

/** Mobs may only stand on floor — never walls/voids, entrance, or exit. */
function mobWalkableCell(raid: RaidState, x: number, y: number): boolean {
  if (!inBounds(x, y)) return false
  if (tileAt(raid.map.tiles, x, y) !== 'floor') return false
  if (livingMobAt(raid, x, y)) return false
  if (x === raid.friend.x && y === raid.friend.y) return false
  return true
}

/** 3×3 around the mob cell (Chebyshev ≤ MOB_VISION). Sees Friend → aggro / chase. */
function mobSeesFriend(raid: RaidState, mob: Mob): boolean {
  const dx = Math.abs(raid.friend.x - mob.x)
  const dy = Math.abs(raid.friend.y - mob.y)
  if (dx === 0 && dy === 0) return false
  return Math.max(dx, dy) <= MOB_VISION
}

function updateMobAggro(raid: RaidState, mob: Mob): void {
  const sees = mobSeesFriend(raid, mob)
  if (sees && !mob.aggro) {
    mob.aggro = true
    raid.log.push(`mob aggro ${mob.id}`)
  } else if (!sees) {
    mob.aggro = false
  }
}

function realPathExists(raid: RaidState, extraBlock?: Set<string>): boolean {
  const goal = getExitCell(raid.map.tiles)
  const from = { x: raid.friend.x, y: raid.friend.y }
  return (
    bfsPathForward(from, goal, (c) => {
      if (isWall(raid, c.x, c.y)) return false
      if (extraBlock?.has(cellKey(c.x, c.y))) return false
      if (livingMobAt(raid, c.x, c.y)) return false
      return true
    }) !== null
  )
}

function wouldCutOnlyPath(raid: RaidState, mob: Mob, dest: Cell): boolean {
  const block = new Set<string>([cellKey(dest.x, dest.y)])
  for (const m of raid.mobs) {
    if (m.hp > 0 && m.id !== mob.id) block.add(cellKey(m.x, m.y))
  }
  return !realPathExists(raid, block) && realPathExists(raid)
}

/** Walls / OOB block; fog does not. Mobs do not block (aggressive charge toward exit). */
function friendWalkableIgnoreMobs(raid: RaidState, c: Cell): boolean {
  if (c.x === raid.friend.x && c.y === raid.friend.y) return true
  return friendCanStand(raid, c.x, c.y)
}

/** Path cells: on-map floor/entrance/exit; fog does not block. Living mobs block (safe / detour). */
function friendWalkable(raid: RaidState, c: Cell): boolean {
  if (c.x === raid.friend.x && c.y === raid.friend.y) return true
  if (!friendCanStand(raid, c.x, c.y)) return false
  if (livingMobAt(raid, c.x, c.y)) return false
  return true
}

function exitGoal(raid: RaidState): Cell {
  if (raid.knowledge.knowsExit && raid.knowledge.exitCell) return raid.knowledge.exitCell
  return getExitCell(raid.map.tiles)
}

/** Shortest forward-biased path to exit: charge (through mobs) or safe (around mobs). */
function pathToExit(raid: RaidState, avoidMobs: boolean): Cell[] | null {
  const goal = exitGoal(raid)
  const walk = avoidMobs
    ? (c: Cell) => friendWalkable(raid, c)
    : (c: Cell) => friendWalkableIgnoreMobs(raid, c)
  return bfsPathForward(raid.friend, goal, walk)
}

function exploreTarget(raid: RaidState): Cell | null {
  const exit = getExitCell(raid.map.tiles)
  const frontiers: Cell[] = []
  for (const key of raid.knowledge.revealed) {
    const [xs, ys] = key.split(',')
    const c = { x: Number(xs), y: Number(ys) }
    if (isWall(raid, c.x, c.y)) continue
    const hasFogNeighbor = neighbors4(c.x, c.y).some((n) => !raid.knowledge.revealed.has(cellKey(n.x, n.y)))
    if (hasFogNeighbor) frontiers.push(c)
  }
  if (!frontiers.length) return null
  frontiers.sort((a, b) => {
    const aHere = a.x === raid.friend.x && a.y === raid.friend.y ? 1 : 0
    const bHere = b.x === raid.friend.x && b.y === raid.friend.y ? 1 : 0
    if (aHere !== bHere) return aHere - bHere
    // Prefer deeper frontiers (forward) before lateral alignment to exit
    if (a.x !== b.x) return b.x - a.x
    const da = manhattan(a, exit) - manhattan(b, exit)
    if (da !== 0) return da
    return manhattan(a, raid.friend) - manhattan(b, raid.friend)
  })
  return frontiers[0] ?? null
}

/** Step into adjacent unexplored floor when standing on a frontier (fog is not a wall). */
function stepIntoFog(raid: RaidState): boolean {
  const exit = getExitCell(raid.map.tiles)
  const options = neighbors4(raid.friend.x, raid.friend.y).filter(
    (n) =>
      !raid.knowledge.revealed.has(cellKey(n.x, n.y)) &&
      !isWall(raid, n.x, n.y) &&
      !livingMobAt(raid, n.x, n.y),
  )
  if (!options.length) return false
  options.sort((a, b) => {
    // Forward first, then closer to exit
    if (a.x !== b.x) return b.x - a.x
    return manhattan(a, exit) - manhattan(b, exit)
  })
  moveFriend(raid, options[0]!.x, options[0]!.y)
  return true
}

/** Free orthogonal neighbors Friend can step onto. */
function friendFreeSteps(raid: RaidState): Cell[] {
  return neighbors4(raid.friend.x, raid.friend.y).filter(
    (c) =>
      friendWalkable(raid, c) &&
      !(c.x === raid.friend.x && c.y === raid.friend.y) &&
      !livingMobAt(raid, c.x, c.y),
  )
}

/** Empty cells where Friend can depth-melee a living mob. */
function fightStanceCells(raid: RaidState): Cell[] {
  const out: Cell[] = []
  const seen = new Set<string>()
  for (const mob of raid.mobs) {
    if (mob.hp <= 0) continue
    for (const n of neighbors4(mob.x, mob.y)) {
      if (n.y !== mob.y || Math.abs(n.x - mob.x) !== 1) continue
      if (n.x === raid.friend.x && n.y === raid.friend.y) continue
      if (!friendWalkable(raid, n) || livingMobAt(raid, n.x, n.y)) continue
      const k = cellKey(n.x, n.y)
      if (seen.has(k)) continue
      seen.add(k)
      out.push(n)
    }
  }
  return out
}

function nearestLivingMob(raid: RaidState): Mob | null {
  let best: Mob | null = null
  let bestD = Infinity
  for (const m of raid.mobs) {
    if (m.hp <= 0) continue
    const d = manhattan(raid.friend, m)
    if (d < bestD) {
      bestD = d
      best = m
    }
  }
  return best
}

/**
 * Never idle if a step exists. Prefer deeper (+x), then closer to exit, then toward mob.
 */
function pickForcedStep(raid: RaidState): Cell | null {
  const exit = getExitCell(raid.map.tiles)
  const free = friendFreeSteps(raid)
  if (!free.length) return null
  const curDist = manhattan(raid.friend, exit)
  const mob = nearestLivingMob(raid)

  const forward = free.filter((c) => c.x > raid.friend.x)
  if (forward.length) {
    forward.sort((a, b) => {
      const da = manhattan(a, exit) - manhattan(b, exit)
      if (da !== 0) return da
      if (mob) {
        const dm = manhattan(a, mob) - manhattan(b, mob)
        if (dm !== 0) return dm
      }
      return Math.abs(a.y - exit.y) - Math.abs(b.y - exit.y)
    })
    return forward[0]!
  }

  const better = free.filter((c) => manhattan(c, exit) < curDist)
  if (better.length) {
    better.sort((a, b) => manhattan(a, exit) - manhattan(b, exit))
    return better[0]!
  }

  if (mob) {
    const curMobDist = manhattan(raid.friend, mob)
    const closer = free.filter((c) => manhattan(c, mob) < curMobDist)
    if (closer.length) return closer[0]!
  }

  free.sort((a, b) => {
    const da = manhattan(a, exit) - manhattan(b, exit)
    if (da !== 0) return da
    return Math.abs(a.y - exit.y) - Math.abs(b.y - exit.y)
  })
  return free[0]!
}

/** Mobs Friend currently sees inside the flinch (~6×6) zone. */
function mobsInFlinchZone(raid: RaidState): Mob[] {
  return raid.mobs.filter((m) => {
    if (m.hp <= 0) return false
    const d = chebyshev(raid.friend, m)
    return d >= 1 && d <= raid.friend.vision && d <= FRIEND_FLINCH_RANGE
  })
}

/**
 * One orthogonal step away from mob, starting from `from`.
 * Prefers the dominant axis of separation. Returns null if blocked.
 */
function oneStepAwayFrom(raid: RaidState, mob: Mob, from: Cell): Cell | null {
  const awayX = Math.sign(from.x - mob.x)
  const awayY = Math.sign(from.y - mob.y)
  const candidates: Cell[] = []
  if (awayX !== 0) candidates.push({ x: from.x + awayX, y: from.y })
  if (awayY !== 0) candidates.push({ x: from.x, y: from.y + awayY })
  if (awayX !== 0 && awayY === 0) {
    candidates.push({ x: from.x, y: from.y - 1 }, { x: from.x, y: from.y + 1 })
  }
  if (awayY !== 0 && awayX === 0) {
    candidates.push({ x: from.x - 1, y: from.y }, { x: from.x + 1, y: from.y })
  }

  const curDist = chebyshev(from, mob)
  for (const c of candidates) {
    if (!inBounds(c.x, c.y)) continue
    if (c.x === from.x && c.y === from.y) continue
    if (!friendWalkable(raid, c)) continue
    if (chebyshev(c, mob) > curDist) return c
  }
  const free = neighbors4(from.x, from.y)
    .filter((c) => friendWalkable(raid, c) && chebyshev(c, mob) > curDist)
    .sort((a, b) => chebyshev(b, mob) - chebyshev(a, mob))
  return free[0] ?? null
}

/** Multi-cell hop away from mob (stops early if blocked). */
function hopAwayFromMob(raid: RaidState, mob: Mob, steps: number): Cell | null {
  let cur = { x: raid.friend.x, y: raid.friend.y }
  let dest: Cell | null = null
  for (let i = 0; i < steps; i++) {
    const next = oneStepAwayFrom(raid, mob, cur)
    if (!next) break
    dest = next
    cur = next
  }
  return dest
}

/**
 * First time each mob enters vision ∩ flinch zone this floor: one fright check.
 * Never re-rolls for that mob afterward. Max FRIEND_FLINCH_MAX successful hops / floor.
 * Hop distance from total fear (Fearless / Dreadful): ≤25% (incl. 0%) → 1 cell;
 * above that (incl. >50%) → 2 cells.
 */
function flinchHopSteps(raid: RaidState): number {
  const pct = Math.round(frightChance(raid.perkMods) * 100)
  if (pct <= 25) return FRIEND_FLINCH_STEPS_LOW
  return FRIEND_FLINCH_STEPS
}

function tryFlinch(raid: RaidState, rng: Rng): boolean {
  if (raid.flinchCount >= FRIEND_FLINCH_MAX) return false

  const checked = new Set(raid.flinchCheckedIds)
  const newcomers = mobsInFlinchZone(raid).filter((m) => !checked.has(m.id))
  if (!newcomers.length) return false

  newcomers.sort((a, b) => chebyshev(raid.friend, a) - chebyshev(raid.friend, b))

  for (const mob of newcomers) {
    // Consume this mob's one check for the round (pass or fail) — no re-roll later
    raid.flinchCheckedIds.push(mob.id)

    const mods = raid.perkMods
    const pct = Math.round(frightChance(mods) * 100)
    const rolled = chance(rng, frightChance(mods))
    const parts: string[] = [`base 25`]
    if (mods.dreadBonus) parts.push(`dread +${mods.dreadBonus}`)
    if (mods.fogFrightBonus) parts.push(`fog +${mods.fogFrightBonus}`)
    if (mods.fearlessCut) parts.push(`fearless −${mods.fearlessCut}`)
    if (mods.eyeFrightCut) parts.push(`eye −${mods.eyeFrightCut}`)
    raid.log.push(
      `[FLINCH] mob#${mob.id} — ${pct}% (${parts.join(', ')}) → ${rolled ? 'PROC' : 'resist'}`,
    )

    if (!rolled) continue
    if (raid.flinchCount >= FRIEND_FLINCH_MAX) continue

    const steps = flinchHopSteps(raid)
    const hop = hopAwayFromMob(raid, mob, steps)
    if (!hop) continue

    moveFriend(raid, hop.x, hop.y)
    raid.flinchCount += 1
    raid.log.push(
      `Flinch hop ${steps} from mob#${mob.id} (${raid.flinchCount}/${FRIEND_FLINCH_MAX}, fear ${pct}%)`,
    )
    return true
  }
  return false
}

function stepFriend(raid: RaidState, rng: Rng): void {
  if (raid.phase !== 'running') return

  // Dash: spend free steps toward exit (no wall/mob) before fighting again
  if (raid.dashStepsLeft > 0) {
    const exit = getExitCell(raid.map.tiles)
    if (manhattan(raid.friend, exit) === 1 && !livingMobAt(raid, exit.x, exit.y)) {
      moveFriend(raid, exit.x, exit.y)
      return
    }
    const dashPath = pathToExit(raid, true)
    if (dashPath && dashPath.length >= 2) {
      const next = dashPath[1]!
      if (friendWalkable(raid, next) && !livingMobAt(raid, next.x, next.y)) {
        moveFriend(raid, next.x, next.y)
        return
      }
    }
    // No free cell toward exit — burn the remaining dash (can't stand still forever)
    raid.log.push(`[DASH] Blocked — ${raid.dashStepsLeft} free step(s) unused`)
    raid.dashStepsLeft = 0
  }

  // Prefer exit when adjacent — last-STA step onto exit must beat fight-in-place
  const exit = getExitCell(raid.map.tiles)
  if (manhattan(raid.friend, exit) === 1 && !livingMobAt(raid, exit.x, exit.y)) {
    moveFriend(raid, exit.x, exit.y)
    return
  }

  const adj = adjacentMobs(raid)
  if (adj.length) {
    fight(raid, adj[0]!)
    raid.stuckTicks++
    return
  }

  // Scare hop: once per mob per floor on first sight in zone → 25%, max 2 hops
  if (tryFlinch(raid, rng)) return

  // ~12%: try safe detour around mobs; otherwise charge shortest forward path (mobs = fight)
  const preferAvoid = chance(rng, FRIEND_AVOID_MOB_P)
  const pathCharge = pathToExit(raid, false)
  const pathSafe = pathToExit(raid, true)

  let path: Cell[] | null = null
  if (preferAvoid && pathSafe && pathSafe.length >= 2) {
    path = pathSafe
  } else if (pathCharge && pathCharge.length >= 2) {
    path = pathCharge
  } else if (pathSafe && pathSafe.length >= 2) {
    path = pathSafe
  }

  // Exit blocked — walk onto a depth-melee stance instead of idling
  if (!path || path.length < 2) {
    const stances = fightStanceCells(raid)
    if (stances.length) {
      const stanceKeys = new Set(stances.map((c) => cellKey(c.x, c.y)))
      path = bfsPathForward(
        raid.friend,
        (c) => stanceKeys.has(cellKey(c.x, c.y)),
        (c) => friendWalkable(raid, c),
      )
    }
  }

  if (!path || path.length < 2) {
    const target = exploreTarget(raid)
    if (target && !(target.x === raid.friend.x && target.y === raid.friend.y)) {
      path = bfsPathForward(raid.friend, target, (c) => friendWalkable(raid, c))
    }
  }

  if ((!path || path.length < 2) && stepIntoFog(raid)) {
    return
  }

  if (path && path.length >= 2) {
    const next = path[1]!
    const blocker = livingMobAt(raid, next.x, next.y)
    if (blocker) {
      const tryDetour = (): boolean => {
        if (!pathSafe || pathSafe.length < 2) return false
        const alt = pathSafe[1]!
        if (livingMobAt(raid, alt.x, alt.y)) return false
        if (alt.x === next.x && alt.y === next.y) {
          // Safe path still wants the same cell — try any free non-forward? prefer lateral detour
          const forced = pickForcedStep(raid)
          if (forced && !(forced.x === next.x && forced.y === next.y)) {
            moveFriend(raid, forced.x, forced.y)
            return true
          }
          return false
        }
        moveFriend(raid, alt.x, alt.y)
        return true
      }

      // Depth-aligned → usually fight; only ~12% (and not stuck) try to sidestep
      if (canMeleeAttack(raid, raid.friend, blocker)) {
        if (raid.stuckTicks < 2 && preferAvoid && tryDetour()) return
        fight(raid, blocker)
        raid.stuckTicks++
        return
      }

      // Path planned through a lateral mob cell — detour or forced forward, never idle
      if (tryDetour()) return
      const forced = pickForcedStep(raid)
      if (forced) {
        moveFriend(raid, forced.x, forced.y)
        return
      }
      raid.stuckTicks++
      return
    }

    if (friendWalkable(raid, next) && !livingMobAt(raid, next.x, next.y)) {
      moveFriend(raid, next.x, next.y)
      return
    }
  }

  const forced = pickForcedStep(raid)
  if (forced) {
    moveFriend(raid, forced.x, forced.y)
    return
  }

  const melee = adjacentMobs(raid)
  if (melee.length) {
    fight(raid, melee[0]!)
    raid.stuckTicks++
    return
  }

  raid.stuckTicks++
  raid.log.push('Wait / repath')
}

function moveFriend(raid: RaidState, x: number, y: number): void {
  if (!friendCanStand(raid, x, y)) return
  if (livingMobAt(raid, x, y)) return
  raid.friend.x = x
  raid.friend.y = y
  if (raid.dashStepsLeft > 0) {
    raid.dashStepsLeft -= 1
    raid.log.push(
      `[DASH] Free step ${x},${y} — ${raid.dashStepsLeft} left (no STA spent)`,
    )
  } else {
    raid.friend.stamina -= 1
  }
  raid.stuckTicks = 0
  const key = cellKey(x, y)
  raid.recentCells.push(key)
  if (raid.recentCells.length > 12) raid.recentCells.shift()

  const exit = getExitCell(raid.map.tiles)
  const dist = manhattan(raid.friend, exit)
  if (dist < raid.lastProgressDist) {
    raid.lastProgressDist = dist
    raid.noProgressTicks = 0
  } else {
    raid.noProgressTicks++
  }

  // Stepping onto exit clears the floor even on the last stamina point
  if (x === exit.x && y === exit.y) {
    raid.phase = 'floorClear'
    raid.log.push(`Floor ${raid.floor} cleared`)
    return
  }

  if (raid.friend.stamina <= 0) {
    raid.phase = 'dead'
    raid.log.push('Friend fallen (stamina)')
  }
}

type MobIntent = { mob: Mob; x: number; y: number; stay: boolean; fight?: boolean }

function freeNeighbors(raid: RaidState, mob: Mob): Cell[] {
  return neighbors4(mob.x, mob.y).filter((n) => mobWalkableCell(raid, n.x, n.y))
}

function chooseWander(mob: Mob, rng: Rng, free: Cell[]): Cell | null {
  if (!free.length) return null
  const roll = rng()
  if (roll < 0.1) return null
  if (roll < 0.3) {
    const nx = mob.x + mob.lastDx
    const ny = mob.y + mob.lastDy
    if (free.some((f) => f.x === nx && f.y === ny)) return { x: nx, y: ny }
  }
  return free[Math.floor(rng() * free.length)]!
}

function chooseChase(raid: RaidState, mob: Mob, free: Cell[]): Cell | null {
  if (!free.length) return null
  const curDist = manhattan(mob, raid.friend)
  const closer = free
    .filter((n) => manhattan(n, raid.friend) < curDist)
    .sort((a, b) => manhattan(a, raid.friend) - manhattan(b, raid.friend))
  return closer[0] ?? null
}

function planMobMoves(raid: RaidState, rng: Rng): MobIntent[] {
  const intents: MobIntent[] = []
  const reserved = new Set<string>()

  for (const mob of raid.mobs) {
    if (mob.hp <= 0) continue

    updateMobAggro(raid, mob)

    if (canMeleeAttack(raid, mob, raid.friend)) {
      intents.push({ mob, x: mob.x, y: mob.y, stay: true, fight: true })
      reserved.add(cellKey(mob.x, mob.y))
      continue
    }

    const free = freeNeighbors(raid, mob).filter((n) => !reserved.has(cellKey(n.x, n.y)))

    let dest: Cell | null = mob.aggro
      ? chooseChase(raid, mob, free)
      : chooseWander(mob, rng, free)

    if (dest && wouldCutOnlyPath(raid, mob, dest)) {
      const safe = free.filter((n) => !wouldCutOnlyPath(raid, mob, n))
      if (mob.aggro) {
        const curDist = manhattan(mob, raid.friend)
        const alts = safe
          .filter((n) => manhattan(n, raid.friend) < curDist)
          .sort((a, b) => manhattan(a, raid.friend) - manhattan(b, raid.friend))
        dest = alts[0] ?? safe[0] ?? null
      } else {
        // Wander: prefer a safe step; if every step would seal the path, still move
        // so the mob does not freeze forever on the corridor.
        dest = safe[0] ?? dest
      }
    }

    if (dest && dest.x === raid.friend.x && dest.y === raid.friend.y) {
      if (canMeleeAttack(raid, mob, raid.friend)) {
        intents.push({ mob, x: mob.x, y: mob.y, stay: true, fight: true })
      } else {
        // Same cell only via lateral step — no horizontal melee; stay put
        intents.push({ mob, x: mob.x, y: mob.y, stay: true })
      }
      reserved.add(cellKey(mob.x, mob.y))
      continue
    }

    if (dest) {
      reserved.add(cellKey(dest.x, dest.y))
      intents.push({ mob, x: dest.x, y: dest.y, stay: false })
    } else {
      intents.push({ mob, x: mob.x, y: mob.y, stay: true })
      reserved.add(cellKey(mob.x, mob.y))
    }
  }
  return intents
}

function applyMobMoves(raid: RaidState, intents: MobIntent[]): void {
  for (const intent of intents) {
    const { mob } = intent
    if (mob.hp <= 0) continue
    if (intent.fight) {
      // Depth-adjacent only → attack in place
      if (canMeleeAttack(raid, mob, raid.friend)) fight(raid, mob)
      continue
    }
    if (intent.stay) continue
    if (intent.x === raid.friend.x && intent.y === raid.friend.y) {
      // Stepping onto Friend only resolves as a hit if depth-aligned
      if (canMeleeAttack(raid, mob, raid.friend)) fight(raid, mob)
      continue
    }
    if (livingMobAt(raid, intent.x, intent.y)) continue
    if (!mobWalkableCell(raid, intent.x, intent.y)) continue
    mob.lastDx = intent.x - mob.x
    mob.lastDy = intent.y - mob.y
    mob.x = intent.x
    mob.y = intent.y
  }
}

export function tickRaid(raid: RaidState, seed?: number): RaidState {
  if (raid.phase !== 'running') return raid
  if (raid.friend.stamina <= 0) {
    raid.phase = 'dead'
    return raid
  }
  const rng: Rng = mulberry32(
    (seed ?? (raid.raidSeed + raid.floor * 1_000_003 + raid.tick * 9973 + 13)) >>> 0,
  )

  raid.tick += 1
  stepFriend(raid, rng)
  revealAround(raid.knowledge, raid.map, raid.friend, raid.mobs)

  // floorClear on last stamina must win — do not treat as death
  if (raid.phase !== 'running') return raid
  if (raid.friend.stamina <= 0) {
    raid.phase = 'dead'
    return raid
  }

  const intents = planMobMoves(raid, rng)
  applyMobMoves(raid, intents)
  revealAround(raid.knowledge, raid.map, raid.friend, raid.mobs)

  if (raid.phase !== 'running') return raid
  if (raid.friend.stamina <= 0) {
    raid.phase = 'dead'
  }

  return raid
}

/** Preview destinations for the next tick without mutating the live raid. */
export function stepAhead(raid: RaidState): { next: RaidState; destinations: Cell[] } {
  const before = cloneRaid(raid)
  const next = tickRaid(cloneRaid(raid))
  const destinations: Cell[] = []
  if (next.friend.x !== before.friend.x || next.friend.y !== before.friend.y) {
    destinations.push({ x: next.friend.x, y: next.friend.y })
  }
  for (const m of next.mobs) {
    if (m.hp <= 0) continue
    const prev = before.mobs.find((b) => b.id === m.id)
    if (!prev || prev.hp <= 0) continue
    if (m.x !== prev.x || m.y !== prev.y) {
      destinations.push({ x: m.x, y: m.y })
    }
  }
  return { next, destinations }
}

export function advanceFloor(raid: RaidState, bp: DungeonBlueprint): RaidState {
  // Derive next floor's seed deterministically from the current one so that
  // the headless sim and the visual Watch produce identical combat on every floor.
  const nextSeed = (((raid.raidSeed >>> 0) * 0x9e3779b9) + (raid.floor * 0x6c62272e)) >>> 0
  const next = startRaid(bp, raid.floor + 1, nextSeed)
  // Keep perk mods across floors; refresh stamina to current max
  next.perkMods = { ...raid.perkMods }
  next.friend.vision = friendVision(next.perkMods)
  next.friend.stamina = friendMaxStamina(next.perkMods, next.floorBaseStamina ?? BASE_STAMINA)
  next.rallyUsedThisFloor = 0
  next.dashStepsLeft = 0
  // Pits stay locked for the whole dungeon — never re-roll
  next.wallsPerkPlaced = raid.wallsPerkPlaced
  next.wallsPerkCells = [...raid.wallsPerkCells]
  stampPerkPits(next.map.tiles, next.wallsPerkCells)
  next.map.walls = rebuildWallSet(next.map.tiles)
  const safe = relocateOffPits(
    next.map.tiles,
    next.mobs.map((m) => ({ x: m.x, y: m.y })),
    mulberry32((next.raidSeed ^ 0x504954) >>> 0),
    new Set([cellKey(next.friend.x, next.friend.y)]),
  )
  next.mobs = next.mobs.map((m, i) => {
    const p = safe[i]
    return p ? { ...m, x: p.x, y: p.y } : m
  })
  // Horde re-rolls each floor
  next.hordePerkSpawned = 0
  // Apply Thick Hide HP bonus to freshly spawned mobs
  if (next.perkMods.mobHpBonus > 0) {
    next.mobs = next.mobs.map((m) => ({ ...m, hp: m.hp + next.perkMods.mobHpBonus }))
  }
  // Only adds pits if rank rose; Horde spawns for this floor
  return ensureStructurePerks(next)
}

export function cloneRaid(raid: RaidState): RaidState {
  return {
    ...raid,
    map: { tiles: [...raid.map.tiles], walls: new Set(raid.map.walls) },
    friend: { ...raid.friend },
    mobs: raid.mobs.map((m) => ({ ...m })),
    knowledge: {
      revealed: new Set(raid.knowledge.revealed),
      tiles: new Map(raid.knowledge.tiles),
      mobs: new Map(raid.knowledge.mobs),
      knowsExit: raid.knowledge.knowsExit,
      exitCell: raid.knowledge.exitCell ? { ...raid.knowledge.exitCell } : null,
    },
    recentCells: [...raid.recentCells],
    log: [...raid.log],
    hurtFlash: raid.hurtFlash,
    clawsFlash: raid.clawsFlash,
    dodgeFlash: raid.dodgeFlash,
    rallyFlash: raid.rallyFlash,
    lastRallyCell: raid.lastRallyCell ? { ...raid.lastRallyCell } : null,
    flinchCount: raid.flinchCount,
    flinchCheckedIds: [...raid.flinchCheckedIds],
    raidSeed: raid.raidSeed,
    perkMods: { ...raid.perkMods },
    rallyUsedThisFloor: raid.rallyUsedThisFloor,
    dashStepsLeft: raid.dashStepsLeft,
    wallsPerkPlaced: raid.wallsPerkPlaced,
    wallsPerkCells: [...raid.wallsPerkCells],
    hordePerkSpawned: raid.hordePerkSpawned,
  }
}
