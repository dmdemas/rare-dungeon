/**
 * Calibration: builds the approved blueprint seed library with LOW dispersion.
 *
 * Pipeline (per tier, parallel across CPU cores):
 *   1. Screen   — CANDIDATES_PER_TIER maps × SCREEN_RAIDS raids (random dungeon perks
 *                 each raid). Drops obvious outliers (wide band around target).
 *   2. Profile  — survivors × up to PROFILE_RAIDS fresh raids (new random dungeon loadout
 *                 each raid, early stop once clearly off-band). Keeps a map only if mean
 *                 clearRate ∈ tight band around target. Perk sensitivity is NOT filtered:
 *                 σ across dungeon loadouts is ~16–41 pp on every map (perk system, not
 *                 map), and Play rolls a fresh loadout per raid, so only the map mean
 *                 drives win streaks. Fixed-loadout sampling would also blur the mean.
 *   3. Validate — random sample of approved maps AND raw (unfiltered) maps, fresh
 *                 VALIDATE_RAIDS raids each → unbiased before/after report:
 *                 mean, true σ, harmonic mean (= win share per raid in a live pool,
 *                 where hard maps survive longer and soak up more raids).
 *
 * Output: src/game/approvedSeeds.ts (poolGen.ts uses it automatically).
 * Written only if a tier has ≥ MIN_APPROVED seeds (poolGen needs 50 per tier).
 *
 * RUN (after any combat mechanic change):
 *   npx tsx scripts/calibrate-pool.ts
 *   npx tsx scripts/calibrate-pool.ts --soft-only   (Hard seeds kept from existing file)
 *   npx tsx scripts/calibrate-pool.ts --hard-only   (Soft seeds kept from existing file)
 *   npx tsx scripts/calibrate-pool.ts --candidates=300 --dry-run   (smoke test, no write)
 *   --workers=N (default: half the cores) · --stall-sec=N (watchdog, default 180)
 */

import { fork, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { generateBlueprint } from '../src/game/mapGen.ts'
import { SOFT, HARD, asHardDungeon, asSoftDungeon } from '../src/game/economy.ts'
import { rollPredefinedDungeonPerks, type PlannedDungeonLoadout } from '../src/game/perks/index.ts'
import { simulateRaid } from '../src/game/headlessRaid.ts'
import { mulberry32, type Rng } from '../src/game/rng.ts'
import type { DungeonBlueprint } from '../src/game/types.ts'
import {
  SOFT_APPROVED_SEEDS as EXISTING_SOFT,
  HARD_APPROVED_SEEDS as EXISTING_HARD,
} from '../src/game/approvedSeeds.ts'

// ── Config ───────────────────────────────────────────────────────────────────

const argValue = (name: string) =>
  process.argv.find((a) => a.startsWith(`${name}=`))?.split('=')[1]

const CANDIDATES_PER_TIER = Number(argValue('--candidates') ?? 10_000)
const SCREEN_RAIDS = 30
const PROFILE_RAIDS = 240
const STOP_CHECK_EVERY = 24
const VALIDATE_MAPS = 300
const VALIDATE_RAIDS = 200
const MIN_APPROVED = 50
const CHUNK = 25
/** Half the cores by default so the machine stays usable; override with --workers=N. */
const WORKERS = Math.max(1, Number(argValue('--workers') ?? Math.floor(os.cpus().length / 2)))
/** Profile stops early once the mean is this many standard errors outside the band. */
const STOP_Z = 3
/** A chunk normally takes ~5–30 s; no reply for this long = stalled worker. */
const STALL_MS = Number(argValue('--stall-sec') ?? 180) * 1000
const MAX_RETRIES = 2
/** Progress line refresh even when no chunk finished (shows the run is alive). */
const HEARTBEAT_MS = 15_000

type Tier = 'soft' | 'hard'

type TierCfg = {
  target: number
  /** Stage 1 keep band (loose — 30 raids are noisy). */
  screen: [number, number]
  /** Stage 2 keep band for mean clearRate. */
  band: [number, number]
}

const TIERS: Record<Tier, TierCfg> = {
  soft: {
    target: SOFT.targetClearP,
    screen: [SOFT.targetClearP - 0.14, SOFT.targetClearP + 0.14],
    band: [SOFT.targetClearP - 0.04, SOFT.targetClearP + 0.04],
  },
  hard: {
    target: HARD.targetClearP,
    screen: [0.03, HARD.targetClearP + 0.1],
    band: [HARD.targetClearP - 0.02, HARD.targetClearP + 0.02],
  },
}

// ── Raid simulation (worker side) ────────────────────────────────────────────

function buildBlueprint(tier: Tier, seed: number): DungeonBlueprint {
  const raw = generateBlueprint(seed, 'cal')
  return tier === 'soft' ? asSoftDungeon(raw) : asHardDungeon(raw)
}

function rollPlan(bp: DungeonBlueprint, rng: Rng): PlannedDungeonLoadout {
  return rollPredefinedDungeonPerks(rng, bp.isCorridor ?? false)
}

function runRaid(bp: DungeonBlueprint, plan: PlannedDungeonLoadout, rng: Rng): boolean {
  return simulateRaid(bp, plan, rng).won
}

/** clearRate with a fresh random dungeon loadout every raid (matches Play). */
function randomLoadoutRate(tier: Tier, seed: number, raids: number, salt: number): number {
  const bp = buildBlueprint(tier, seed)
  const rng = mulberry32((seed ^ salt) >>> 0)
  let wins = 0
  for (let r = 0; r < raids; r++) {
    if (runRaid(bp, rollPlan(bp, rng), rng)) wins++
  }
  return wins / raids
}

/** One-sided z-test of wins/n against the band edges (variance taken at the edge). */
function clearlyOutside(wins: number, n: number, [lo, hi]: [number, number]): boolean {
  const p = wins / n
  return (
    p < lo - STOP_Z * Math.sqrt((lo * (1 - lo)) / n) ||
    p > hi + STOP_Z * Math.sqrt((hi * (1 - hi)) / n)
  )
}

type Profile = { rate: number; stopped: boolean }

/** clearRate with a fresh loadout per raid; bails out once the map is clearly off-band. */
function profileRate(tier: Tier, seed: number): Profile {
  const bp = buildBlueprint(tier, seed)
  const rng = mulberry32((seed ^ 0x9f0e3c21) >>> 0)
  let wins = 0
  for (let n = 1; n <= PROFILE_RAIDS; n++) {
    if (runRaid(bp, rollPlan(bp, rng), rng)) wins++
    if (n % STOP_CHECK_EVERY === 0 && clearlyOutside(wins, n, TIERS[tier].band)) {
      return { rate: wins / n, stopped: true }
    }
  }
  return { rate: wins / PROFILE_RAIDS, stopped: false }
}

type JobKind = 'screen' | 'profile' | 'validate'
type Job = { id: number; kind: JobKind; tier: Tier; seeds: number[] }
type Reply = { id: number; results: unknown[] }

const HANDLERS: Record<JobKind, (tier: Tier, seed: number) => unknown> = {
  screen: (tier, seed) => randomLoadoutRate(tier, seed, SCREEN_RAIDS, 0x5c12a7e3),
  profile: profileRate,
  validate: (tier, seed) => randomLoadoutRate(tier, seed, VALIDATE_RAIDS, 0x7a11d0b5),
}

function workerMain(): void {
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // Not permitted on some systems — run at normal priority.
  }
  process.on('message', (job: Job) => {
    const results = job.seeds.map((s) => HANDLERS[job.kind](job.tier, s))
    process.send!({ id: job.id, results } satisfies Reply)
  })
  process.on('disconnect', () => process.exit(0))
}

// ── Worker pool (master side) ────────────────────────────────────────────────

function bar(done: number, total: number, width = 30): string {
  const filled = Math.round((done / total) * width)
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']'
}

const RUN_T0 = Date.now()

function clock(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Worker pool with a stall watchdog: a worker that crashes or does not answer a chunk
 * within STALL_MS is killed and replaced, and its chunk re-queued (MAX_RETRIES per chunk).
 */
class WorkerPool {
  private readonly workers: ChildProcess[]
  private readonly script = fileURLToPath(import.meta.url)

  constructor(n: number) {
    this.workers = Array.from({ length: n }, () => this.spawn())
  }

  private spawn(): ChildProcess {
    return fork(this.script, ['--worker'], { execArgv: process.execArgv })
  }

  run<R>(kind: JobKind, tier: Tier, seeds: number[], label: string): Promise<R[]> {
    const chunks: number[][] = []
    for (let i = 0; i < seeds.length; i += CHUNK) chunks.push(seeds.slice(i, i + CHUNK))
    const out: R[][] = new Array(chunks.length)
    const queue = chunks.map((_, i) => i)
    const retries = new Map<number, number>()
    const busy = new Map<ChildProcess, { id: number; since: number }>()
    const t0 = Date.now()
    let done = 0
    let doneSeeds = 0
    let finished = false

    const progress = () => {
      const now = Date.now()
      const elapsed = (now - t0) / 1000
      const eta = doneSeeds ? (elapsed / doneSeeds) * (seeds.length - doneSeeds) : 0
      const oldest = Math.max(0, ...[...busy.values()].map((j) => now - j.since))
      process.stdout.write(
        `\r  T+${clock(now - RUN_T0)}  ${label.padEnd(9)} ${bar(doneSeeds, seeds.length)} ` +
          `${doneSeeds}/${seeds.length}  ${elapsed.toFixed(0)}s  eta ${eta.toFixed(0)}s  ` +
          `oldest chunk ${(oldest / 1000).toFixed(0)}s   `,
      )
    }

    return new Promise((resolve, reject) => {
      if (!chunks.length) return resolve([])

      const detachAll = () => {
        for (const w of this.workers) {
          w.removeAllListeners('message')
          w.removeAllListeners('exit')
        }
      }

      const stop = (err?: Error) => {
        if (finished) return
        finished = true
        clearInterval(watchdog)
        detachAll()
        process.stdout.write('\n')
        if (err) reject(err)
        else resolve(out.flat())
      }

      const assign = (w: ChildProcess) => {
        const id = queue.shift()
        if (id === undefined) return
        busy.set(w, { id, since: Date.now() })
        try {
          w.send({ id, kind, tier, seeds: chunks[id]! } satisfies Job)
        } catch {
          replace(w, 'IPC channel closed')
        }
      }

      const replace = (w: ChildProcess, reason: string) => {
        if (finished) return
        const job = busy.get(w)
        busy.delete(w)
        w.removeAllListeners('message')
        w.removeAllListeners('exit')
        w.kill()
        const fresh = this.spawn()
        this.workers[this.workers.indexOf(w)] = fresh
        attach(fresh)
        if (job) {
          const n = (retries.get(job.id) ?? 0) + 1
          if (n > MAX_RETRIES) {
            stop(new Error(`${label}: chunk ${job.id} failed ${n}× (${reason}); seeds ${chunks[job.id]!.join(', ')}`))
            return
          }
          retries.set(job.id, n)
          queue.unshift(job.id)
          process.stdout.write(`\n  ⚠ ${label}: worker ${reason} on chunk ${job.id} — restarted, retry ${n}/${MAX_RETRIES}\n`)
        }
        assign(fresh)
      }

      const attach = (w: ChildProcess) => {
        w.on('message', (msg: Reply) => {
          busy.delete(w)
          if (out[msg.id] === undefined) {
            out[msg.id] = msg.results as R[]
            done++
            doneSeeds += chunks[msg.id]!.length
          }
          progress()
          if (done === chunks.length) stop()
          else assign(w)
        })
        w.on('exit', (code) => replace(w, `exited (code ${code})`))
      }

      const watchdog = setInterval(() => {
        const now = Date.now()
        for (const [w, job] of busy) {
          if (now - job.since > STALL_MS) replace(w, `no reply for ${STALL_MS / 1000}s`)
        }
        progress()
      }, HEARTBEAT_MS)

      detachAll()
      for (const w of this.workers) {
        attach(w)
        assign(w)
      }
    })
  }

  close(): void {
    for (const w of this.workers) {
      w.removeAllListeners('exit')
      if (w.connected) w.disconnect()
    }
  }
}

// ── Stats ────────────────────────────────────────────────────────────────────

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
function variance(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)
}
/** Expected binomial sampling variance of per-map rates measured with n raids. */
function noiseVar(rates: number[], n: number): number {
  return mean(rates.map((p) => (p * (1 - p)) / Math.max(1, n - 1)))
}
function trueSigma(rates: number[], n: number): number {
  return Math.sqrt(Math.max(0, variance(rates) - noiseVar(rates, n)))
}
/** Win share per raid in a live pool (each map raided until cleared). */
function harmonicMean(rates: number[], n: number): number {
  const floor = 0.5 / n
  return 1 / mean(rates.map((p) => 1 / Math.max(floor, p)))
}

type ValidationStats = {
  mean: number
  sigmaTrue: number
  harmonic: number
  below: number
}

function validationStats(rates: number[], target: number): ValidationStats {
  return {
    mean: mean(rates),
    sigmaTrue: trueSigma(rates, VALIDATE_RAIDS),
    harmonic: harmonicMean(rates, VALIDATE_RAIDS),
    below: rates.filter((p) => p < target * 0.5).length / Math.max(1, rates.length),
  }
}

function sample<T>(items: readonly T[], n: number, rng: Rng): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy.slice(0, n)
}

// ── Calibrate one tier ───────────────────────────────────────────────────────

type TierResult = { seeds: number[]; before: ValidationStats; after: ValidationStats }

async function calibrateTier(pool: WorkerPool, tier: Tier, baseSeed: number): Promise<TierResult> {
  const cfg = TIERS[tier]
  const rng = mulberry32(baseSeed >>> 0)
  const candidates = Array.from({ length: CANDIDATES_PER_TIER }, () => (rng() * 0x100000000) >>> 0)

  console.log(`\n── ${tier.toUpperCase()}  target ${pct(cfg.target)} ──`)

  const screenRates = await pool.run<number>('screen', tier, candidates, 'screen')
  const screened = candidates.filter(
    (_, i) => screenRates[i]! >= cfg.screen[0] && screenRates[i]! <= cfg.screen[1],
  )
  console.log(
    `  1. screen  ${screened.length}/${candidates.length} kept ` +
      `(band ${pct(cfg.screen[0])}–${pct(cfg.screen[1])}, ${SCREEN_RAIDS} raids)`,
  )

  const profiles = await pool.run<Profile>('profile', tier, screened, 'profile')
  const approved: { seed: number; rate: number }[] = []
  let stoppedEarly = 0
  screened.forEach((seed, i) => {
    const { rate, stopped } = profiles[i]!
    if (stopped) stoppedEarly++
    if (stopped || rate < cfg.band[0] || rate > cfg.band[1]) return
    approved.push({ seed, rate })
  })
  console.log(
    `  2. profile ${approved.length}/${screened.length} kept ` +
      `(mean ${pct(cfg.band[0])}–${pct(cfg.band[1])}, up to ${PROFILE_RAIDS} raids; ` +
      `${stoppedEarly} stopped early)`,
  )

  const vRng = mulberry32((baseSeed ^ 0x51ed270b) >>> 0)
  const rawSample = sample(candidates, VALIDATE_MAPS, vRng)
  const approvedSample = sample(approved.map((a) => a.seed), VALIDATE_MAPS, vRng)
  const rawRates = await pool.run<number>('validate', tier, rawSample, 'val raw')
  const approvedRates = await pool.run<number>('validate', tier, approvedSample, 'val new')

  approved.sort((a, b) => Math.abs(a.rate - cfg.target) - Math.abs(b.rate - cfg.target))
  return {
    seeds: approved.map((a) => a.seed),
    before: validationStats(rawRates, cfg.target),
    after: validationStats(approvedRates, cfg.target),
  }
}

function printReport(tier: Tier, r: TierResult): void {
  const t = TIERS[tier].target
  const lose6 = (p: number) => pct((1 - p) ** 6)
  const row = (label: string, s: ValidationStats) =>
    `  ${label.padEnd(10)} mean ${pct(s.mean).padStart(6)}  σ ${pct(s.sigmaTrue).padStart(6)}  ` +
    `live-pool win/raid ${pct(s.harmonic).padStart(6)}  ` +
    `maps < ${pct(t * 0.5)}: ${pct(s.below).padStart(6)}  P(lose 6) ${lose6(s.harmonic)}`
  console.log(`\n  ${tier.toUpperCase()} (fresh ${VALIDATE_RAIDS} raids × ${VALIDATE_MAPS} maps, σ = true, noise removed)`)
  console.log(row('raw', r.before))
  console.log(r.seeds.length ? row('approved', r.after) : '  approved   —')
  console.log(`  approved seeds: ${r.seeds.length}`)
}

// ── Output ───────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
  return chunks
}

function seedArray(name: string, seeds: readonly number[]): string {
  return (
    `export const ${name}: readonly number[] = [\n` +
    chunkArray([...seeds], 10).map((row) => '  ' + row.join(', ')).join(',\n') +
    `\n] as const\n`
  )
}

function writeSeeds(soft: readonly number[], hard: readonly number[], note: string): void {
  const s = TIERS.soft
  const h = TIERS.hard
  const banner = `/**
 * AUTO-GENERATED by scripts/calibrate-pool.ts — DO NOT EDIT MANUALLY.
 * Re-generate: npx tsx scripts/calibrate-pool.ts [--soft-only | --hard-only]
 *
 * Seeds pass: screen → mean clearRate band (random dungeon loadouts, as in Play).
 *   Soft: mean ${pct(s.band[0])}–${pct(s.band[1])}  —  ${soft.length} seeds
 *   Hard: mean ${pct(h.band[0])}–${pct(h.band[1])}  —  ${hard.length} seeds
 * ${note}
 *
 * Config: ${CANDIDATES_PER_TIER} candidates/tier, screen ${SCREEN_RAIDS} raids,
 *   profile up to ${PROFILE_RAIDS} raids.
 * Generated: ${new Date().toISOString()}
 */

`
  const outPath = path.join(process.cwd(), 'src', 'game', 'approvedSeeds.ts')
  fs.writeFileSync(
    outPath,
    banner + seedArray('SOFT_APPROVED_SEEDS', soft) + '\n' + seedArray('HARD_APPROVED_SEEDS', hard),
    'utf8',
  )
  console.log(`\n✅ Written: ${outPath}`)
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const softOnly = process.argv.includes('--soft-only')
  const hardOnly = process.argv.includes('--hard-only')
  const dryRun = process.argv.includes('--dry-run')

  console.log('═══════════════════════════════════════════════════════')
  console.log('  calibrate-pool: low-dispersion seed library')
  console.log(`  ${CANDIDATES_PER_TIER} candidates/tier · ${WORKERS} worker processes`)
  console.log('═══════════════════════════════════════════════════════')

  const t0 = RUN_T0
  const pool = new WorkerPool(WORKERS)
  let soft: readonly number[] = EXISTING_SOFT
  let hard: readonly number[] = EXISTING_HARD
  const notes: string[] = []
  if (softOnly) notes.push('Hard: preserved from previous calibration')
  if (hardOnly) notes.push('Soft: preserved from previous calibration')

  try {
    if (!hardOnly) {
      const r = await calibrateTier(pool, 'soft', 0xdeadbeef)
      printReport('soft', r)
      if (r.seeds.length >= MIN_APPROVED) soft = r.seeds
      else notes.push(`Soft: only ${r.seeds.length} approved (< ${MIN_APPROVED}) — kept previous seeds`)
    }
    if (!softOnly) {
      const r = await calibrateTier(pool, 'hard', 0xcafebabe)
      printReport('hard', r)
      if (r.seeds.length >= MIN_APPROVED) hard = r.seeds
      else notes.push(`Hard: only ${r.seeds.length} approved (< ${MIN_APPROVED}) — kept previous seeds`)
    }
  } finally {
    pool.close()
  }

  for (const n of notes) console.log(`\n⚠ ${n}`)
  if (dryRun) console.log('\n(dry run — approvedSeeds.ts not written)')
  else writeSeeds(soft, hard, notes.length ? notes.join('; ') : 'Both tiers freshly calibrated.')
  console.log(`Total time: ${clock(Date.now() - t0)}`)
}

if (process.argv.includes('--worker')) workerMain()
else
  main().catch((err: unknown) => {
    console.error(`\n❌ Calibration aborted at T+${clock(Date.now() - RUN_T0)}: ${(err as Error).message}`)
    console.error('   approvedSeeds.ts was NOT written.')
    process.exit(1)
  })
