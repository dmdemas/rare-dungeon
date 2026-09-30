/**
 * Проверяет: совпадает ли реальный % побед игрока с ожидаемым
 * для данжей из generateDungeonPool (50 Soft + 50 Hard).
 *
 * Метод:
 *  - Генерирует 5 пулов (разные сиды) × (50S + 50H данжей)
 *  - Каждый данж получает RAIDS_PER_DUNGEON попыток рейда
 *  - Рейд = реальный tickRaid() из raid.ts (не вероятность!)
 *  - Выводит per-dungeon % побед + агрегат vs target (32% / 11%)
 *
 *   npx tsx scripts/sim-pool-win-rate.ts
 */
import { generateDungeonPool } from '../src/game/poolGen.ts'
import { SOFT, HARD } from '../src/game/economy.ts'
import {
  createEmptyPerksState,
  revealDungeonPick,
  rollFriendOffer,
  rollPredefinedDungeonPerks,
  selectFriendPerk,
  syncRaidWithPerks,
  type FriendPerkId,
} from '../src/game/perks/index.ts'
import { advanceFloor, startRaid, tickRaid } from '../src/game/raid.ts'
import { mulberry32 } from '../src/game/rng.ts'
import type { DungeonBlueprint } from '../src/game/types.ts'

// ── Config ───────────────────────────────────────────────────────────────────

const POOL_SEEDS = [0xdeadbeef, 0xcafe0001, 0xabcd1234, 0x12345678, 0xfeedface]
const RAIDS_PER_DUNGEON = 200  // raids simulated per dungeon
const MAX_TICKS = 600          // safety cap per floor

// Friend perk value table (greedy pick — same as calibrate-pool.ts)
const FV: Record<FriendPerkId, number> = {
  dash: 100, fearless: 92, sharpEye: 90, endurance: 85, rally: 84, dodge: 70,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${(100 * n).toFixed(1)}%`
}
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}
function minmax(xs: number[]): [number, number] {
  return [Math.min(...xs), Math.max(...xs)]
}

// ── Run one raid attempt (all 3 floors) ──────────────────────────────────────
// Uses rollPredefinedDungeonPerks (random) — matches actual game (RaidView.tsx)
// and calibrate-pool.ts. Single shared RNG for dungeon plan + friend offers.

function runRaid(bp: DungeonBlueprint, raidSeed: number): 'won' | 'dead' {
  const rng = mulberry32(raidSeed >>> 0)
  const dungeonPlan = rollPredefinedDungeonPerks(rng, bp.isCorridor ?? false)

  let perks = createEmptyPerksState()
  let raid = startRaid(bp, 1)

  for (let floor = 1; floor <= 3; floor++) {
    // Friend picks best perk offer this floor
    const offer = rollFriendOffer(perks, rng)
    if (offer) {
      const id: FriendPerkId = (FV[offer[0]] ?? 0) >= (FV[offer[1]] ?? 0) ? offer[0] : offer[1]
      perks = selectFriendPerk(perks, id)
    }
    // Reveal dungeon perk slot for this floor
    perks = { ...perks, dungeon: revealDungeonPick(perks.dungeon, dungeonPlan, floor - 1) }
    raid = syncRaidWithPerks(raid, perks)

    // Simulate ticks until phase changes
    let ticks = 0
    while (raid.phase === 'running' && ticks++ < MAX_TICKS) {
      raid = tickRaid(raid)
    }
    if (raid.phase === 'running') return 'dead'  // safety timeout → treat as dead

    if (raid.phase === 'dead') return 'dead'
    if (raid.phase === 'won') return 'won'
    if (raid.phase === 'floorClear') {
      if (floor >= 3) return 'won'
      raid = advanceFloor(raid, bp)
      continue
    }
    return 'dead'
  }
  return 'dead'
}

// ── Per-dungeon win rate ──────────────────────────────────────────────────────

function measureDungeon(bp: DungeonBlueprint, poolSeedOffset: number): number {
  let wins = 0
  for (let r = 0; r < RAIDS_PER_DUNGEON; r++) {
    const raidSeed = (poolSeedOffset ^ (r * 1664525 + 1013904223)) >>> 0
    if (runRaid(bp, raidSeed) === 'won') wins++
  }
  return wins / RAIDS_PER_DUNGEON
}

// ── Histogram ────────────────────────────────────────────────────────────────

function histogram(rates: number[], buckets: number, lo = 0, hi = 1): string {
  const counts = new Array<number>(buckets).fill(0)
  for (const r of rates) {
    const idx = Math.min(buckets - 1, Math.floor((r - lo) / ((hi - lo) / buckets)))
    counts[Math.max(0, idx)]++
  }
  const lines: string[] = []
  for (let i = 0; i < buckets; i++) {
    const from = (lo + (i / buckets) * (hi - lo)) * 100
    const to = (lo + ((i + 1) / buckets) * (hi - lo)) * 100
    const bar = '█'.repeat(counts[i]!)
    lines.push(`  ${from.toFixed(0).padStart(3)}–${to.toFixed(0).padStart(3)}%: ${bar} (${counts[i]})`)
  }
  return lines.join('\n')
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  sim-pool-win-rate: player clear% vs target')
  console.log(`  Pools: ${POOL_SEEDS.length} seeds × (50 Soft + 50 Hard)`)
  console.log(`  Raids per dungeon: ${RAIDS_PER_DUNGEON}`)
  console.log('═══════════════════════════════════════════════════════════════\n')

  const allSoftRates: number[] = []
  const allHardRates: number[] = []

  for (const [pi, seed] of POOL_SEEDS.entries()) {
    const pool = generateDungeonPool(seed, 50, 50)
    const soft = pool.filter(d => d.tier === 'soft')
    const hard = pool.filter(d => d.tier === 'hard')

    console.log(`── Pool ${pi + 1} (seed 0x${seed.toString(16)}) ──`)

    const softRates = soft.map((bp, i) => {
      const rate = measureDungeon(bp, seed ^ (i * 9973))
      return rate
    })
    const hardRates = hard.map((bp, i) => {
      const rate = measureDungeon(bp, seed ^ ((50 + i) * 9973))
      return rate
    })

    allSoftRates.push(...softRates)
    allHardRates.push(...hardRates)

    const [sMin, sMax] = minmax(softRates)
    const [hMin, hMax] = minmax(hardRates)
    console.log(
      `  Soft: mean ${pct(mean(softRates))} ` +
      `σ=${pct(stddev(softRates))} ` +
      `range [${pct(sMin)}–${pct(sMax)}] ` +
      `target ${pct(SOFT.targetClearP)}`
    )
    console.log(
      `  Hard: mean ${pct(mean(hardRates))} ` +
      `σ=${pct(stddev(hardRates))} ` +
      `range [${pct(hMin)}–${pct(hMax)}] ` +
      `target ${pct(HARD.targetClearP)}`
    )

    // Flag outlier dungeons (>2× or <0.3× target)
    const softOutliers = soft.filter((bp, i) =>
      softRates[i]! > SOFT.targetClearP * 2.5 || softRates[i]! < SOFT.targetClearP * 0.2
    )
    const hardOutliers = hard.filter((bp, i) =>
      hardRates[i]! > HARD.targetClearP * 2.5 || hardRates[i]! < HARD.targetClearP * 0.2
    )
    if (softOutliers.length) {
      const names = softOutliers.map((bp, _, arr) => {
        const idx = soft.indexOf(bp)
        return `${bp.name} (${pct(softRates[idx]!)})`
      })
      console.log(`  ⚠ Soft outliers: ${names.join(', ')}`)
    }
    if (hardOutliers.length) {
      const names = hardOutliers.map((bp) => {
        const idx = hard.indexOf(bp)
        return `${bp.name} (${pct(hardRates[idx]!)})`
      })
      console.log(`  ⚠ Hard outliers: ${names.join(', ')}`)
    }
    console.log()
  }

  // ── Aggregate across all pools ──
  const [sMin, sMax] = minmax(allSoftRates)
  const [hMin, hMax] = minmax(allHardRates)
  const softMean = mean(allSoftRates)
  const hardMean = mean(allHardRates)

  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  AGGREGATE across all pools')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log()
  console.log(`  SOFT (n=${allSoftRates.length} dungeons × ${RAIDS_PER_DUNGEON} raids each)`)
  console.log(`    Target clear %:   ${pct(SOFT.targetClearP)}`)
  console.log(`    Measured mean:    ${pct(softMean)}  (delta ${(100*(softMean - SOFT.targetClearP)).toFixed(1)}pp)`)
  console.log(`    Std-dev:          ${pct(stddev(allSoftRates))}`)
  console.log(`    Range:            ${pct(sMin)} – ${pct(sMax)}`)
  console.log(`    VERDICT: ${Math.abs(softMean - SOFT.targetClearP) < 0.05 ? '✅ PASS (within ±5pp of target)' : '❌ FAIL (>5pp off target)'}`)
  console.log()
  console.log(`  HARD (n=${allHardRates.length} dungeons × ${RAIDS_PER_DUNGEON} raids each)`)
  console.log(`    Target clear %:   ${pct(HARD.targetClearP)}`)
  console.log(`    Measured mean:    ${pct(hardMean)}  (delta ${(100*(hardMean - HARD.targetClearP)).toFixed(1)}pp)`)
  console.log(`    Std-dev:          ${pct(stddev(allHardRates))}`)
  console.log(`    Range:            ${pct(hMin)} – ${pct(hMax)}`)
  console.log(`    VERDICT: ${Math.abs(hardMean - HARD.targetClearP) < 0.04 ? '✅ PASS (within ±4pp of target)' : '❌ FAIL (>4pp off target)'}`)

  // ── Distribution histogram ──
  console.log()
  console.log('  Soft clear% distribution across all dungeon instances:')
  console.log(histogram(allSoftRates, 10, 0, 0.8))
  console.log()
  console.log('  Hard clear% distribution across all dungeon instances:')
  console.log(histogram(allHardRates, 10, 0, 0.4))

  // ── Six-game losing streak probability ──
  console.log()
  console.log('  ── "6 losses in a row" probability (player complaint check) ──')
  const softLose6 = Math.pow(1 - softMean, 6)
  const hardLose6 = Math.pow(1 - hardMean, 6)
  console.log(`    Soft: P(lose 6 straight) = ${pct(softLose6)}  — 1 in ${(1/softLose6).toFixed(0)} sessions`)
  console.log(`    Hard: P(lose 6 straight) = ${pct(hardLose6)}  — 1 in ${(1/hardLose6).toFixed(0)} sessions`)
  console.log(`    Note: Soft P(lose 6) ≈ ${pct(Math.pow(1-SOFT.targetClearP, 6))} at target ${pct(SOFT.targetClearP)}`)
  console.log()
  console.log('  Run complete.')
}

main()
