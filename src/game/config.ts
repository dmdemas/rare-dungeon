export const MAP_W = 15
export const MAP_H = 4

/**
 * Grid: 15 columns (depth entrance→exit) × 4 rows (lateral).
 * Entrance column near camera, exit column far.
 */
export const ENTRANCE_X = 0
export const EXIT_X = MAP_W - 1

export const BASE_VISION = 5
export const BASE_ATTACK = 1
export const BASE_STAMINA = 15
export const MOB_HP = 1
export const MOB_DAMAGE = 1
/** Mob vision: 3×3 around own cell (Chebyshev ≤ 1, includes diagonals). */
export const MOB_VISION = 1

export const BASE_TICK_MS = 1000
/** Plan / highlight phase before the jump. */
export const THINK_MS = 800
/** Snap / jump phase after highlight. */
export const JUMP_MS = 200
/** Dash burst: faster than normal (think + jump ≈ 400ms). */
export const DASH_THINK_MS = 280
export const DASH_JUMP_MS = 120

/**
 * When Friend has 1–5 STA left, stretch think+jump (not during Dash).
 * STA 5 → +10% · 4 → +15% · 3 → +20% · 2 → +25% · 1 → +30%.
 */
export function lowStaminaTickFactor(stamina: number): number {
  if (stamina <= 0 || stamina >= 6) return 1
  return 1 + 0.05 * (7 - stamina)
}

/** Base pits per map, % (min 5, max 12; chance falls as count rises). */
export const WALL_COUNT_WEIGHTS: { count: number; weight: number }[] = [
  { count: 5, weight: 22 },
  { count: 6, weight: 19.5 },
  { count: 7, weight: 17 },
  { count: 8, weight: 14.5 },
  { count: 9, weight: 12 },
  { count: 10, weight: 7.5 },
  { count: 11, weight: 5 },
  { count: 12, weight: 2.5 },
]

/**
 * Starting mobs per map, % (max 4; a 5th only via the Horde perk).
 * Cumulative: ≥1 always, ≥2 50%, ≥3 15%, 4 = 2.5%.
 */
export const MOB_COUNT_WEIGHTS: { count: number; weight: number }[] = [
  { count: 1, weight: 50 },
  { count: 2, weight: 35 },
  { count: 3, weight: 12.5 },
  { count: 4, weight: 2.5 },
]

/**
 * Hard-only mob spawn weights — mainly 1–2 mobs; 3 is rare (5%), 4 extremely rare (1%).
 * Individual: 1→49%, 2→45%, 3→5%, 4→1%.
 */
export const HARD_MOB_COUNT_WEIGHTS: { count: number; weight: number }[] = [
  { count: 1, weight: 49 },
  { count: 2, weight: 45 },
  { count: 3, weight: 5 },
  { count: 4, weight: 1 },
]

/**
 * Chance to take a safe detour around a mob instead of charging forward / fighting.
 * ~10–15%; the rest of the time prefer shortest forward path (into the fight).
 */
export const FRIEND_AVOID_MOB_P = 0.12

/**
 * When a mob newly enters Friend vision inside this Chebyshev range (~6×6 area),
 * Friend may flinch away (see FRIEND_FLINCH_P). One roll per mob per floor.
 */
export const FRIEND_FLINCH_RANGE = 3
/** Chance to flinch away the first time a mob enters the flinch zone this floor. */
export const FRIEND_FLINCH_P = 0.25
/** Max successful flinch hops per floor / round. */
export const FRIEND_FLINCH_MAX = 3
/**
 * Flinch hop length from total fear chance (Fearless / Dreadful):
 * ≤25% (can be 0%) → 1 cell; >25% (incl. >50%) → 2 cells.
 */
export const FRIEND_FLINCH_STEPS = 2
export const FRIEND_FLINCH_STEPS_LOW = 1

export const DIRS: readonly { dx: number; dy: number }[] = [
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
]

/** Friend BFS neighbor order: depth-forward first, then lateral, then back. */
export const FRIEND_DIRS: readonly { dx: number; dy: number }[] = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
]
