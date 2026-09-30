/**
 * Offline world history → src/game/worldSnapshots.ts
 *
 * Each snapshot runs a full AI world on real headless raids:
 *   - 80 Soft + 80 Hard live dungeons from the approved preset pools
 *   - every step one AI raider (bare/perk1/perkHunt/yolo) raids a random live dungeon
 *   - wipe → raider takes 95% bank, owner loses the stake, a new dungeon is created
 *   - survive → bank/wins/tickets grow, AI owner (claimer/holder/whale) may claim
 * After warm-up the live dungeons are the snapshot (50 shown + 30 reserve per tier);
 * the last LOG_STEPS steps are the replay window (pool inflow, tickets, feed).
 *
 * Feed: extreme positives (top clears / claims) + typical-or-smaller losses (~20%).
 *
 *   npx tsx scripts/gen-world-snapshots.ts [--snapshots=4] [--dry-run]
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { generateBlueprint } from '../src/game/mapGen.ts'
import {
  HARD,
  SOFT,
  TICKET,
  asHardDungeon,
  asSoftDungeon,
  rerollCostSum,
  settleHardClaimWithTax,
  settleSoftClaim,
  type DungeonTier,
} from '../src/game/economy.ts'
import { HARD_APPROVED_SEEDS, SOFT_APPROVED_SEEDS } from '../src/game/approvedSeeds.ts'
import { DUNGEON_NAMES } from '../src/game/poolGen.ts'
import { mulberry32, type Rng } from '../src/game/rng.ts'
import {
  applyRaidStep,
  ownerCreateRerolls,
  ownerWantsClaim,
  rollOwnerKind,
  runEconomyRaid,
  type OwnerKind,
} from '../src/game/worldSim.ts'
import {
  LIVE_PER_TIER,
  WORLD_STEP_MS,
  type FeedItem,
  type SnapDungeon,
  type WorldSnapshot,
} from '../src/game/worldTypes.ts'
import type { DungeonBlueprint } from '../src/game/types.ts'

const argValue = (name: string) =>
  process.argv.find((a) => a.startsWith(`${name}=`))?.split('=')[1]

const SNAPSHOTS = Number(argValue('--snapshots') ?? 4)
/** Raider sees this many random live dungeons and raids the richest (1 = uniform pick). */
const RAIDER_PREVIEWS = Number(argValue('--previews') ?? 1)
const DRY_RUN = process.argv.includes('--dry-run')
const RESERVE_PER_TIER = 30
const WARMUP_STEPS = 8000
const LOG_STEPS = 1500
const SOFT_RAID_SHARE = 0.5
/** Positive feed = top this fraction of clears / claims per tier, by ×. */
const TOP_POSITIVE_FRAC: Record<DungeonTier, number> = { soft: 0.1, hard: 0.25 }
/** Share of negatives in the feed. */
const NEG_SHARE = 0.2
/** Share of Hard items among feed positives and among feed negatives. */
const HARD_FEED_SHARE = 0.8
const HISTORY_POSITIVES = 40

const TIERS: DungeonTier[] = ['soft', 'hard']
const NAME_SUFFIXES = ['', ' II', ' III', ' IV']

type LiveDungeon = { bp: DungeonBlueprint; owner: OwnerKind; seed: number }
type StepLog = { pool: number; tickets: number; events: FeedItem[] }

type SimOut = {
  live: Record<DungeonTier, LiveDungeon[]>
  steps: StepLog[]
}

function simulateWorld(worldSeed: number): SimOut {
  const rng = mulberry32(worldSeed)
  const namesInUse = new Set<string>()
  const live: Record<DungeonTier, LiveDungeon[]> = { soft: [], hard: [] }

  const freshName = (): string => {
    for (;;) {
      const base = DUNGEON_NAMES[Math.floor(rng() * DUNGEON_NAMES.length)]!
      const name = base + NAME_SUFFIXES[Math.floor(rng() * NAME_SUFFIXES.length)]!
      if (!namesInUse.has(name)) {
        namesInUse.add(name)
        return name
      }
    }
  }

  /** New AI dungeon; returns $ that went into rewardPool (fee + create rerolls). */
  const create = (tier: DungeonTier, rngLocal: Rng): { d: LiveDungeon; pool: number } => {
    const seeds = tier === 'hard' ? HARD_APPROVED_SEEDS : SOFT_APPROVED_SEEDS
    const seed = seeds[Math.floor(rngLocal() * seeds.length)]!
    const owner = rollOwnerKind(rngLocal)
    const rerolls$ = rerollCostSum(ownerCreateRerolls(tier, owner, rngLocal))
    const cfg = tier === 'hard' ? HARD : SOFT
    const raw = generateBlueprint(seed, freshName())
    const wrap = tier === 'hard' ? asHardDungeon : asSoftDungeon
    const bp = wrap({
      ...raw,
      bank: cfg.createToBank,
      wins: 0,
      invested: cfg.createCost + rerolls$,
      ticketPower: 0,
    })
    return { d: { bp, owner, seed }, pool: cfg.createFee + rerolls$ }
  }

  const replace = (tier: DungeonTier, idx: number): number => {
    namesInUse.delete(live[tier][idx]!.bp.name)
    const { d, pool } = create(tier, rng)
    live[tier][idx] = d
    return pool
  }

  for (const tier of TIERS) {
    for (let i = 0; i < LIVE_PER_TIER + RESERVE_PER_TIER; i++) live[tier].push(create(tier, rng).d)
  }

  const steps: StepLog[] = []
  for (let s = 0; s < WARMUP_STEPS + LOG_STEPS; s++) {
    const log: StepLog = { pool: 0, tickets: 0, events: [] }
    const tier: DungeonTier = rng() < SOFT_RAID_SHARE ? 'soft' : 'hard'
    let idx = Math.floor(rng() * live[tier].length)
    for (let k = 1; k < RAIDER_PREVIEWS; k++) {
      const alt = Math.floor(rng() * live[tier].length)
      if ((live[tier][alt]!.bp.bank ?? 0) > (live[tier][idx]!.bp.bank ?? 0)) idx = alt
    }
    const d = live[tier][idx]!
    const name = d.bp.name
    const wins = d.bp.wins ?? 0
    const invested = d.bp.invested ?? 0
    const r = runEconomyRaid(d.bp, rng)
    log.pool += r.poolAdd

    if (r.wiped) {
      log.events.push({ kind: 'clear', tier, name, wins, payout: r.payout, paid: r.raiderPaid })
      log.events.push({ kind: 'wiped', tier, name, wins, lost: invested })
      log.tickets -= (d.bp.ticketPower ?? 0) * TICKET.wipeBurnFrac
      log.pool += replace(tier, idx)
    } else {
      log.events.push({ kind: 'fail', tier, name, floor: r.floor, lost: r.raiderPaid })
      d.bp = applyRaidStep(d.bp, r)
      log.tickets += r.ticketsMinted
      const bank = d.bp.bank ?? 0
      const w = d.bp.wins ?? 0
      if (ownerWantsClaim(tier, d.owner, bank, w, invested)) {
        let payout: number
        if (tier === 'hard') {
          const c = settleHardClaimWithTax(bank, w)
          payout = c.ownerPayout
          log.pool += c.fee + c.taxed
          if (w < TICKET.unlockWins) {
            log.tickets -= (d.bp.ticketPower ?? 0) * (1 - TICKET.earlyClaimKeepFrac)
          }
        } else {
          const c = settleSoftClaim(bank, w)
          payout = c.ownerPayout
          log.pool += c.fee
        }
        log.events.push({ kind: 'claim', tier, name, wins: w, payout, invested })
        log.pool += replace(tier, idx)
      }
    }
    steps.push(log)
  }
  return { live, steps }
}

// ── Feed selection ───────────────────────────────────────────────────────────

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return Infinity
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))]!
}

const positiveMetric = (e: FeedItem): number =>
  e.kind === 'clear' ? e.payout / e.paid : e.kind === 'claim' ? e.payout / e.invested : 0

type Thresholds = Record<string, number>

function thresholds(steps: StepLog[]): Thresholds {
  const t: Thresholds = {}
  for (const tier of TIERS) {
    const of = (kind: FeedItem['kind']) =>
      steps.flatMap((s) => s.events.filter((e) => e.kind === kind && e.tier === tier))
    t[`clear:${tier}`] = quantile(of('clear').map(positiveMetric), 1 - TOP_POSITIVE_FRAC[tier])
    t[`claim:${tier}`] = quantile(of('claim').map(positiveMetric), 1 - TOP_POSITIVE_FRAC[tier])
    t[`fail:${tier}`] = quantile(of('fail').map((e) => (e as { lost: number }).lost), 0.5)
    t[`wiped:${tier}`] = quantile(of('wiped').map((e) => (e as { lost: number }).lost), 0.5)
  }
  return t
}

function isPositive(e: FeedItem, t: Thresholds): boolean {
  if (e.kind !== 'clear' && e.kind !== 'claim') return false
  return positiveMetric(e) >= t[`${e.kind}:${e.tier}`]!
}

function isNegative(e: FeedItem, t: Thresholds): boolean {
  if (e.kind !== 'fail' && e.kind !== 'wiped') return false
  return e.lost <= t[`${e.kind}:${e.tier}`]! + 1e-9
}

type Stamped = { step: number; item: FeedItem }

function selectFeed(steps: StepLog[], from: number, to: number, t: Thresholds, rng: Rng): Stamped[] {
  const pos: Stamped[] = []
  const neg: Stamped[] = []
  for (let s = from; s < to; s++) {
    for (const item of steps[s]!.events) {
      if (isPositive(item, t)) pos.push({ step: s, item })
      else if (isNegative(item, t)) neg.push({ step: s, item })
    }
  }
  const shuffled = (xs: Stamped[]) => {
    const a = [...xs]
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[a[i], a[j]] = [a[j]!, a[i]!]
    }
    return a
  }
  const ofTier = (xs: Stamped[], tier: DungeonTier) => xs.filter((s) => s.item.tier === tier)

  const hardPos = ofTier(pos, 'hard')
  const softPos = shuffled(ofTier(pos, 'soft')).slice(
    0,
    Math.round((hardPos.length * (1 - HARD_FEED_SHARE)) / HARD_FEED_SHARE),
  )
  const posCount = hardPos.length + softPos.length
  const negWanted = Math.round((posCount * NEG_SHARE) / (1 - NEG_SHARE))
  const hardNegCount = Math.round(negWanted * HARD_FEED_SHARE)
  const hardNeg = shuffled(ofTier(neg, 'hard')).slice(0, hardNegCount)
  const softNeg = shuffled(ofTier(neg, 'soft')).slice(0, negWanted - hardNeg.length)
  return [...hardPos, ...softPos, ...hardNeg, ...softNeg].sort((a, b) => a.step - b.step)
}

// ── Snapshot + report ────────────────────────────────────────────────────────

const r2 = (x: number) => Math.round(x * 100) / 100
const r3 = (x: number) => Math.round(x * 1000) / 1000

function toSnap(d: LiveDungeon): SnapDungeon {
  return {
    seed: d.seed,
    name: d.bp.name,
    wins: d.bp.wins ?? 0,
    bank: r2(d.bp.bank ?? 0),
    tickets: r3(d.bp.ticketPower ?? 0),
    invested: r2(d.bp.invested ?? 0),
  }
}

function buildSnapshot(worldSeed: number): { snap: WorldSnapshot; sim: SimOut } {
  const sim = simulateWorld(worldSeed)
  const rng = mulberry32((worldSeed ^ 0x5eed) >>> 0)
  const t = thresholds(sim.steps)
  const logFrom = WARMUP_STEPS
  const logTo = WARMUP_STEPS + LOG_STEPS

  const history = selectFeed(sim.steps, 0, logFrom, t, rng)
  const histPos = history.filter((h) => isPositive(h.item, t)).slice(-HISTORY_POSITIVES)
  const histFrom = histPos[0]?.step ?? logFrom
  const historyItems = history.filter((h) => h.step >= histFrom).map((h) => h.item)

  const live = selectFeed(sim.steps, logFrom, logTo, t, rng).map((s) => ({
    step: s.step - logFrom,
    item: s.item,
  }))

  const shuffled = (tier: DungeonTier) => {
    const list = [...sim.live[tier]]
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[list[i], list[j]] = [list[j]!, list[i]!]
    }
    return list.map(toSnap)
  }

  const window = sim.steps.slice(logFrom, logTo)
  return {
    snap: {
      soft: shuffled('soft'),
      hard: shuffled('hard'),
      poolCents: window.map((s) => Math.round(s.pool * 100)),
      tickets: window.map((s) => r3(s.tickets)),
      history: historyItems,
      live,
    },
    sim,
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

function report(i: number, snap: WorldSnapshot, sim: SimOut): void {
  const window = sim.steps.slice(WARMUP_STEPS)
  const events = window.flatMap((s) => s.events)
  console.log(`\n── snapshot ${i + 1} ──`)
  for (const tier of TIERS) {
    const shown = snap[tier].slice(0, LIVE_PER_TIER)
    const raids = events.filter((e) => e.tier === tier && (e.kind === 'fail' || e.kind === 'clear'))
    const clears = events.filter((e) => e.tier === tier && e.kind === 'clear') as Extract<FeedItem, { kind: 'clear' }>[]
    const claims = events.filter((e) => e.tier === tier && e.kind === 'claim') as Extract<FeedItem, { kind: 'claim' }>[]
    const wins = shown.map((d) => d.wins)
    console.log(
      `  ${tier.padEnd(4)} shown wins mean ${mean(wins).toFixed(1)} max ${Math.max(...wins)}` +
        ` · bank mean $${mean(shown.map((d) => d.bank)).toFixed(2)}` +
        ` · clear/raid ${pct(clears.length / Math.max(1, raids.length))}` +
        ` · clear × mean ${mean(clears.map((c) => c.payout / c.paid)).toFixed(2)}` +
        ` · claim ROI mean ${mean(claims.map((c) => c.payout / c.invested)).toFixed(2)}×` +
        ` · claims ${claims.length} wipes ${clears.length}`,
    )
    const entry = tier === 'hard' ? HARD.entryCost : SOFT.entryCost
    const xs = clears.map((c) => c.payout / entry)
    const held = clears.filter((c) => c.wins >= TICKET.unlockWins - 1).map((c) => c.payout / entry)
    const band = xs.filter((x) => x >= 8 && x <= 10.5).length
    console.log(
      `       raider win × entry $${entry}: mean ${mean(xs).toFixed(2)} median ${quantile(xs, 0.5).toFixed(2)}` +
        ` p90 ${quantile(xs, 0.9).toFixed(2)} · 8–10.5× ${pct(band / Math.max(1, xs.length))}` +
        (tier === 'hard' ? ` · held (wins ≥${TICKET.unlockWins - 1}) mean ${mean(held).toFixed(2)} n=${held.length}` : '') +
        ` · if-won-now on shown 50: mean ${mean(shown.map((d) => ((d.bank + (tier === 'hard' ? HARD.entryToBank : SOFT.entryToBank)) * 0.95) / entry)).toFixed(2)}`,
    )
  }
  const poolPerMin = (mean(snap.poolCents) / 100) * (60_000 / WORLD_STEP_MS)
  const neg = snap.live.filter((l) => l.item.kind === 'fail' || l.item.kind === 'wiped').length
  console.log(
    `  replay ${LOG_STEPS} steps (${((LOG_STEPS * WORLD_STEP_MS) / 60_000).toFixed(0)} min)` +
      ` · pool +$${poolPerMin.toFixed(2)}/min · feed ${snap.live.length} live (${neg} losses,` +
      ` ${pct(snap.live.filter((l) => l.item.tier === 'hard').length / Math.max(1, snap.live.length))} Hard)` +
      ` + ${snap.history.length} history`,
  )
}

function main(): void {
  const t0 = Date.now()
  const base = (Date.now() ^ 0x9e3779b9) >>> 0
  const snaps: WorldSnapshot[] = []
  for (let i = 0; i < SNAPSHOTS; i++) {
    const { snap, sim } = buildSnapshot((base + i * 0x632be5ab) >>> 0)
    report(i, snap, sim)
    snaps.push(snap)
  }
  console.log(`\nTotal ${((Date.now() - t0) / 1000).toFixed(1)} s`)
  if (DRY_RUN) {
    console.log('--dry-run: worldSnapshots.ts not written')
    return
  }
  const here = path.dirname(fileURLToPath(import.meta.url))
  const out = path.resolve(here, '../src/game/worldSnapshots.ts')
  const body =
    `// AUTO-GENERATED by scripts/gen-world-snapshots.ts — DO NOT EDIT.\n` +
    `// ${new Date().toISOString()} · ${SNAPSHOTS} snapshots · ${WARMUP_STEPS} warm-up + ${LOG_STEPS} replay steps\n` +
    `import type { WorldSnapshot } from './worldTypes'\n\n` +
    `export const WORLD_SNAPSHOTS: readonly WorldSnapshot[] = ${JSON.stringify(snaps)}\n`
  fs.writeFileSync(out, body)
  console.log(`Written: ${out} (${(body.length / 1024).toFixed(0)} KB)`)
}

main()
