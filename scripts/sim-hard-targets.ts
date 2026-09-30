/**
 * Hard targets pipeline: 1k → tune → 1k → 10k.
 *
 * Friend: base clear ~10%; with offer rerolls up to ~25%; pot ~8–10× entry.
 * Dungeon: survive ~9/10 raids; owner ~2–2.5× create (+ shares) when claims/holds well.
 * Both sides may reroll perk offers (Hard only).
 *
 *   npx tsx scripts/sim-hard-targets.ts
 * Writes: hard-targets-out.txt
 */
import { writeFileSync } from 'node:fs'
import { generateBlueprint } from '../src/game/mapGen.ts'
import {
  HARD,
  SOFT,
  DUNGEON_SCALE_UNIT_ABS,
  absoluteDungeonPowerScale,
  distributePoolEpoch,
  hardBankAfterKills,
  hardClosePayout,
  hardRaiderClearPayout,
  hardRoi,
  hardSuggestedClose,
  rerollCostSum,
} from '../src/game/economy.ts'
import {
  createEmptyPerksState,
  createEmptySideState,
  FRIEND_PERK_IDS,
  DUNGEON_PERK_IDS,
  revealDungeonPick,
  rollFriendOffer,
  rollOffer,
  selectFriendPerk,
  selectPerk,
  syncRaidWithPerks,
  type DungeonPerkId,
  type FriendPerkId,
  type PlannedDungeonLoadout,
} from '../src/game/perks/index.ts'
import { advanceFloor, startRaid, tickRaid } from '../src/game/raid.ts'
import { mulberry32 } from '../src/game/rng.ts'
import type { DungeonBlueprint, RaidState } from '../src/game/types.ts'

const FV: Record<FriendPerkId, number> = {
  dash: 100,
  fearless: 92,
  sharpEye: 90,
  endurance: 85,
  rally: 84,
  dodge: 70,
}
const DV: Record<DungeonPerkId, number> = {
  horde: 100,
  dreadfulBeasts: 92,
  fog: 88,
  walls: 85,
  thickHide: 82,
  sharpClaws: 78,
}

type Ease = { scale: number; sta: number; fright: number }

const lines: string[] = []
function log(s = '') {
  lines.push(s)
  console.log(s)
}
function pct(x: number) {
  return `${(100 * x).toFixed(1)}%`
}
function mean(xs: number[]) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
}

function play(r: RaidState): RaidState {
  let t = 0
  while (r.phase === 'running' && t++ < 600) r = tickRaid(r)
  return r.phase === 'running' ? { ...r, phase: 'dead' } : r
}

/** Reroll 2-card offer until it contains a target (or budget exhausted). */
function offerWithRerolls<T extends string>(
  roll: () => [T, T] | null,
  want: (o: [T, T]) => boolean,
  budget: { left: number },
): [T, T] | null {
  let o = roll()
  if (!o) return null
  while (budget.left > 0 && !want(o)) {
    budget.left--
    const next = roll()
    if (!next) break
    o = next
  }
  return o
}

function planDungeon(
  rng: () => number,
  createRerollBudget: number,
  smart: boolean,
): { planned: PlannedDungeonLoadout; rerollsUsed: number } {
  let side = createEmptySideState<DungeonPerkId>()
  const picks: PlannedDungeonLoadout['picks'] = []
  const budget = { left: createRerollBudget }
  const start = createRerollBudget
  for (let i = 0; i < 3; i++) {
    const o = offerWithRerolls(
      () => rollOffer('dungeon', side.ranks, rng),
      (pair) => (smart ? DV[pair[0]!] >= 88 || DV[pair[1]!] >= 88 : false),
      budget,
    )
    if (!o) break
    const id = smart
      ? DV[o[0]!] >= DV[o[1]!]
        ? o[0]!
        : o[1]!
      : o[Math.floor(rng() * 2)]!
    side = selectPerk(side, id)
    const rank = side.ranks[id]
    if (rank) picks.push({ id, rank })
  }
  return { planned: { picks }, rerollsUsed: start - budget.left }
}

type RaidOpts = {
  ease: Ease
  friendSmart: boolean
  /** Total Friend offer rerolls across the 3 floors. */
  friendRerollBudget: number
  /** Create-side dungeon offer rerolls while planning 3 slots. */
  createRerollBudget: number
  /** If set, force these friend picks (causal). */
  forceFriend?: FriendPerkId[]
  /** If set, force dungeon loadout (causal). */
  forceDungeon?: DungeonPerkId[]
}

function oneRaid(seed: number, opts: RaidOpts): boolean {
  const perkRng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  const mapRng = mulberry32((seed ^ 0xdeadbeef) >>> 0)
  const { ease } = opts
  const bp: DungeonBlueprint = {
    ...generateBlueprint((seed * 1664525 + 1013904223) >>> 0, 'h'),
    tier: 'hard',
    dungeonPowerScale: ease.scale,
  }

  let planned: PlannedDungeonLoadout
  if (opts.forceDungeon) {
    const id = opts.forceDungeon[0]!
    planned = {
      picks: [
        { id, rank: 1 },
        { id, rank: 2 },
        { id, rank: 3 },
      ],
    }
  } else {
    planned = planDungeon(mapRng, opts.createRerollBudget, true).planned
  }

  let perks = createEmptyPerksState()
  let raid = startRaid(bp, 1)
  const softEase =
    ease.sta || ease.fright
      ? { staminaBonus: ease.sta, frightCut: ease.fright, dodgeFloor: 0 }
      : undefined
  raid = { ...raid, tier: 'hard', dungeonPowerScale: ease.scale, softEase }

  const budget = { left: opts.friendRerollBudget }
  let forcedIdx = 0

  for (let floor = 1; floor <= 3; floor++) {
    if (opts.forceFriend && forcedIdx < opts.forceFriend.length) {
      perks = selectFriendPerk(perks, opts.forceFriend[forcedIdx++]!)
    } else {
      // Rerolls buy perk control: hunt Dash (dominant win perk) while budget lasts.
      const o = offerWithRerolls(
        () => rollFriendOffer(perks, perkRng),
        (pair) =>
          opts.friendRerollBudget <= 0
            ? true
            : pair[0] === 'dash' || pair[1] === 'dash',
        budget,
      )
      if (o) {
        const id = opts.friendSmart
          ? FV[o[0]!] >= FV[o[1]!]
            ? o[0]!
            : o[1]!
          : o[Math.floor(perkRng() * 2)]!
        perks = selectFriendPerk(perks, id)
      }
    }
    perks = { ...perks, dungeon: revealDungeonPick(perks.dungeon, planned, floor - 1) }
    raid = syncRaidWithPerks(raid, perks)
    raid = play(raid)
    if (raid.phase === 'dead') return false
    if (raid.phase === 'floorClear' || raid.phase === 'won') {
      if (floor >= 3 || raid.phase === 'won') return true
      raid = advanceFloor(raid, bp)
      raid = { ...raid, tier: 'hard', dungeonPowerScale: ease.scale, softEase }
      continue
    }
    return false
  }
  return false
}

function clearRate(n: number, seed: number, opts: RaidOpts): number {
  let w = 0
  for (let i = 0; i < n; i++) if (oneRaid(seed + i * 9973, opts)) w++
  return w / n
}

/** Causal: force perk on slot1 vs baseline random smart — delta clear. */
function causalFriend(ease: Ease, n: number, seed: number): { id: FriendPerkId; clear: number; lift: number }[] {
  const base = clearRate(n, seed, {
    ease,
    friendSmart: true,
    friendRerollBudget: 0,
    createRerollBudget: 0,
  })
  const out: { id: FriendPerkId; clear: number; lift: number }[] = []
  for (const id of FRIEND_PERK_IDS) {
    let w = 0
    for (let i = 0; i < n; i++) {
      if (
        oneRaid(seed + 50_000 + i * 9973, {
          ease,
          friendSmart: true,
          friendRerollBudget: 0,
          createRerollBudget: 0,
          forceFriend: [id, id, id], // rank up same line if offered via select — actually selectFriendPerk ranks up
        })
      )
        w++
    }
    // forceFriend applies select three times → rank III of that line if allowed
    const p = w / n
    out.push({ id, clear: p, lift: p - base })
  }
  return out.sort((a, b) => b.lift - a.lift)
}

function causalDungeon(ease: Ease, n: number, seed: number) {
  const base = clearRate(n, seed, {
    ease,
    friendSmart: true,
    friendRerollBudget: 0,
    createRerollBudget: 0,
  })
  const out: { id: DungeonPerkId; clear: number; lift: number }[] = []
  for (const id of DUNGEON_PERK_IDS) {
    let w = 0
    for (let i = 0; i < n; i++) {
      if (
        oneRaid(seed + 90_000 + i * 9973, {
          ease,
          friendSmart: true,
          friendRerollBudget: 0,
          createRerollBudget: 0,
          forceDungeon: [id, id, id],
        })
      )
        w++
    }
    const p = w / n
    out.push({ id, clear: p, lift: p - base })
  }
  return out.sort((a, b) => a.lift - b.lift) // more negative = harder dungeon
}

type OwnerKind = 'claimer' | 'mid' | 'holder'

function ownerWorld(
  clearP: number,
  n: number,
  seed: number,
  mix: { claimer: number; mid: number; holder: number },
  liveSoft: number,
  liveHard: number,
  meanCreateRerolls: number,
  meanFriendRerolls: number,
) {
  const rng = mulberry32(seed)
  const friendPots: number[] = []
  const ownerRois: number[] = []
  let wipes = 0
  let claims = 0
  let sumKills = 0
  let attempts = 0
  let clears = 0

  for (let d = 0; d < n; d++) {
    const u = rng()
    const kind: OwnerKind =
      u < mix.claimer ? 'claimer' : u < mix.claimer + mix.mid ? 'mid' : 'holder'
    const closeRoi = kind === 'claimer' ? 2.0 : kind === 'mid' ? 2.5 : 99
    const cr = Math.max(0, Math.round(meanCreateRerolls + (rng() - 0.5) * 2))
    const cr$ = rerollCostSum(cr)
    const invested = HARD.createCost + cr$
    let shares = distributePoolEpoch(cr$, liveSoft, liveHard).hardPerDungeon
    let kills = 0
    let claim = 0
    let wiped = false

    while (kills < HARD.maxLiveWins) {
      const fr = Math.max(0, Math.round(meanFriendRerolls + (rng() - 0.4) * 2))
      const fr$ = rerollCostSum(fr)
      attempts++
      const poolAdd = HARD.entryToOwnerPool + fr$
      if (rng() < clearP) {
        const bank = hardBankAfterKills(kills) + HARD.entryToBank
        const pot = hardRaiderClearPayout(bank)
        friendPots.push(pot / HARD.entryCost)
        clears++
        wiped = true
        wipes++
        shares += distributePoolEpoch(poolAdd, liveSoft, liveHard).hardPerDungeon
        break
      }
      kills++
      shares += distributePoolEpoch(poolAdd, liveSoft, liveHard).hardPerDungeon
      const bank = hardBankAfterKills(kills)
      const pay = hardClosePayout(bank, kills)
      if (kills >= HARD.minWinsBeforeClaim && hardRoi(pay) >= closeRoi - 0.02) {
        claim = pay
        claims++
        break
      }
    }
    if (!wiped && !claim) {
      claim = hardClosePayout(hardBankAfterKills(kills), kills)
      claims++
    }
    sumKills += kills
    const total = claim + shares
    ownerRois.push(hardRoi(total, invested))
  }

  const m810 = friendPots.filter((x) => x >= 8 && x <= 10.5).length
  return {
    clearPerAttempt: clears / Math.max(1, attempts),
    wipeRate: wipes / n,
    claimRate: claims / n,
    survivePerRaid: 1 - clears / Math.max(1, attempts),
    meanFriendPotX: mean(friendPots),
    fracFriendPot810: friendPots.length ? m810 / friendPots.length : 0,
    meanOwnerRoi: mean(ownerRois),
    meanKills: sumKills / n,
    friendPots,
    ownerRois,
  }
}

function pickEase(n: number, seed: number): { ease: Ease; p: number } {
  const cands: Ease[] = [
    { scale: 1, sta: 0, fright: 0 },
    { scale: 0.95, sta: 0, fright: 0 },
    { scale: 0.92, sta: 0, fright: 0 },
    { scale: 0.9, sta: 0, fright: 0 },
    { scale: 0.88, sta: 0, fright: 0 },
    { scale: 0.88, sta: 1, fright: 0 },
    { scale: 0.85, sta: 1, fright: 0 },
    { scale: 0.85, sta: 1, fright: 5 },
    { scale: 0.9, sta: 1, fright: 0 },
    { scale: 0.92, sta: 1, fright: 0 },
  ]
  let best = cands[0]!
  let bestP = 0
  let bestDist = 99
  log('── Combat ease sweep (base: smart Friend, 0 Friend rerolls, dungeon smart 0 create-reroll) ──')
  for (const e of cands) {
    const p = clearRate(n, seed + Math.floor(e.scale * 1000) + e.sta * 17 + e.fright, {
      ease: e,
      friendSmart: true,
      friendRerollBudget: 0,
      createRerollBudget: 0,
    })
    log(`  scale=${e.scale} sta+${e.sta} fr-${e.fright} → clear ${pct(p)}`)
    const dist = Math.abs(p - 0.1)
    if (dist < bestDist) {
      bestDist = dist
      best = e
      bestP = p
    }
  }
  return { ease: best, p: bestP }
}

function runPass(label: string, nCombat: number, nWorld: number, ease: Ease, seed: number) {
  log(`\n######## ${label} (combat n=${nCombat}, world n=${nWorld}) ########`)
  log(`ease ${JSON.stringify(ease)}`)

  const base = clearRate(nCombat, seed, {
    ease,
    friendSmart: true,
    friendRerollBudget: 0,
    createRerollBudget: 0,
  })
  log(`\n══ Friend clear (base, 0 Friend rerolls) ══`)
  log(`  clear ${pct(base)}   target ~10%`)

  log(`\n══ Friend reroll budget → clear (hunt top Friend perks) ══`)
  const rerollPoints: { fr: number; p: number; spend: number }[] = []
  for (const fr of [0, 1, 2, 3, 4, 6]) {
    const p = clearRate(nCombat, seed + 1000 + fr * 99, {
      ease,
      friendSmart: true,
      friendRerollBudget: fr,
      createRerollBudget: 0,
    })
    const spend = rerollCostSum(fr)
    rerollPoints.push({ fr, p, spend })
    log(`  Friend rerolls=${fr} ($${spend.toFixed(2)}) → clear ${pct(p)}`)
  }

  log(`\n══ Dungeon create-reroll budget → Friend clear (stronger dungeon) ══`)
  for (const cr of [0, 1, 2, 3, 5]) {
    const p = clearRate(nCombat, seed + 2000 + cr * 77, {
      ease,
      friendSmart: true,
      friendRerollBudget: 0,
      createRerollBudget: cr,
    })
    log(`  create rerolls=${cr} ($${rerollCostSum(cr).toFixed(2)}) → Friend clear ${pct(p)}`)
  }

  // Combined: Friend max rerolls vs dungeon that also rerolled a bit
  const pFriendMax = clearRate(nCombat, seed + 3001, {
    ease,
    friendSmart: true,
    friendRerollBudget: 6,
    createRerollBudget: 1,
  })
  log(`\n  Friend rerolls=6 + dungeon createRerolls=1 → clear ${pct(pFriendMax)}   target Friend cap ~25%`)

  const softP = clearRate(Math.min(400, nCombat), seed + 4000, {
    ease: {
      scale: absoluteDungeonPowerScale('soft'),
      sta: SOFT.friendStaminaBonus,
      fright: SOFT.friendFrightCut,
    },
    friendSmart: true,
    friendRerollBudget: 0,
    createRerollBudget: 0,
  })
  // Soft path uses softEase via tier — oneRaid is hard-only; use separate soft check from constants
  log(`\n══ Soft hierarchy (reference from SOFT consts via hard runner scale) ══`)
  log(`  (Soft full verify separate; here Soft-ish clear with SOFT ease on Hard pipeline skipped)`)
  void softP

  const causalN = Math.min(300, nCombat)
  log(`\n══ Causal Friend perk lift (force line III-ish, n=${causalN}) ══`)
  const cf = causalFriend(ease, causalN, seed + 5000)
  for (const row of cf) {
    log(`  ${row.id.padEnd(12)} clear ${pct(row.clear)}  lift ${row.lift >= 0 ? '+' : ''}${pct(row.lift)}`)
  }

  log(`\n══ Causal Dungeon perk (force line — lower Friend clear = stronger dungeon, n=${causalN}) ══`)
  const cd = causalDungeon(ease, causalN, seed + 6000)
  for (const row of cd) {
    log(`  ${row.id.padEnd(14)} Friend clear ${pct(row.clear)}  Δ ${row.lift >= 0 ? '+' : ''}${pct(row.lift)}`)
  }

  // Economy worlds — two mixes
  log(`\n══ Owner world @ clearP=${pct(base)} ══`)
  const mixes: { name: string; mix: { claimer: number; mid: number; holder: number } }[] = [
    { name: 'early-claim meta (most claim @≥7 / 2×)', mix: { claimer: 0.7, mid: 0.2, holder: 0.1 } },
    { name: 'balanced humans', mix: { claimer: 0.4, mid: 0.35, holder: 0.25 } },
    { name: 'hold-heavy (fat pots)', mix: { claimer: 0.2, mid: 0.3, holder: 0.5 } },
  ]
  for (const m of mixes) {
    const w = ownerWorld(base, nWorld, seed + 7000 + Math.floor(m.mix.holder * 100), m.mix, 3, 2, 1.5, 1)
    log(`\n  [${m.name}]`)
    log(`    dungeon survive / raid   ${pct(w.survivePerRaid)}   (target ~90%)`)
    log(`    Friend takes dungeon     ${pct(w.wipeRate)}`)
    log(`    mean Friend pot ×        ${w.meanFriendPotX.toFixed(2)}×   (target 8–10)  in 8–10.5: ${pct(w.fracFriendPot810)}`)
    log(`    mean Owner ROI           ${w.meanOwnerRoi.toFixed(2)}×   (target ~2–2.5)  mean kills ${w.meanKills.toFixed(1)}`)
  }

  return { base, rerollPoints, pFriendMax }
}

function main() {
  log('HARD targets pipeline')
  log('Friend: ~10% base clear; rerolls → up to ~25%; pot ~8–10× entry')
  log('Dungeon: survive ~9/10; owner ~2–2.5× create (+shares)')
  log('Rerolls: Friend offers + dungeon create offers (Hard). Costs → rewardPool.')
  log('Parity entry-discount = WIP (create-raid-parity rule) — not applied here.')
  log('')

  // ── Pass 1: 1k sweep + tune ──
  const sweep = pickEase(1000, 0x4a010000)
  let ease = sweep.ease
  log(`\nChosen ease after 1k sweep: ${JSON.stringify(ease)} clear=${pct(sweep.p)}`)

  // Nudge toward 10% if needed
  if (Math.abs(sweep.p - 0.1) > 0.02) {
    const nudge: Ease =
      sweep.p < 0.1
        ? { scale: Math.max(0.8, ease.scale - 0.03), sta: ease.sta + (ease.sta < 2 ? 1 : 0), fright: ease.fright }
        : { scale: Math.min(1, ease.scale + 0.03), sta: Math.max(0, ease.sta - (sweep.p > 0.14 ? 1 : 0)), fright: ease.fright }
    const p2 = clearRate(1000, 0x4a020000, {
      ease: nudge,
      friendSmart: true,
      friendRerollBudget: 0,
      createRerollBudget: 0,
    })
    log(`Nudge → ${JSON.stringify(nudge)} clear=${pct(p2)}`)
    if (Math.abs(p2 - 0.1) < Math.abs(sweep.p - 0.1)) ease = nudge
  }

  const pass1 = runPass('PASS1 1k', 1000, 1000, ease, 0x4a100000)

  // Tune for TWO anchors: base≈10% AND dash-hunt (reroll=6)≈25%. Never soften so hard that base breaks.
  log('\n── Anchor sweep: base≈10% & Dash-hunt(reroll6)≈25% ──')
  const anchors: Ease[] = [
    ease,
    { scale: 0.92, sta: 1, fright: 0 },
    { scale: 0.9, sta: 1, fright: 0 },
    { scale: 0.88, sta: 1, fright: 0 },
    { scale: 0.9, sta: 0, fright: 0 },
    { scale: 0.95, sta: 1, fright: 0 },
    { scale: 0.88, sta: 0, fright: 0 },
    { scale: 0.85, sta: 1, fright: 0 },
    { scale: 1.0, sta: 1, fright: 0 },
  ]
  let ease2 = ease
  let bestScore = 1e9
  for (const e of anchors) {
    const b = clearRate(800, 0x4a11a000 + Math.floor(e.scale * 1000) + e.sta * 13, {
      ease: e,
      friendSmart: true,
      friendRerollBudget: 0,
      createRerollBudget: 0,
    })
    const h = clearRate(800, 0x4a11b000 + Math.floor(e.scale * 1000) + e.sta * 13, {
      ease: e,
      friendSmart: true,
      friendRerollBudget: 6,
      createRerollBudget: 0,
    })
    const score = Math.abs(b - 0.1) * 2 + Math.abs(h - 0.25)
    log(`  ${JSON.stringify(e)} base ${pct(b)} dashHunt ${pct(h)} score ${score.toFixed(3)}`)
    if (score < bestScore) {
      bestScore = score
      ease2 = e
    }
  }
  log(`TUNING pick: ${JSON.stringify(ease2)}`)

  // Persist ease into HARD-like summary (do not auto-write economy.ts unless clearly better)
  const pass2 = runPass('PASS2 1k after tune', 1000, 1000, ease2, 0x4a200000)
  const pass3 = runPass('PASS3 10k FINAL', 10_000, 10_000, ease2, 0x4a300000)

  log('\n######## FINAL VERDICT ########')
  log(`ease locked for this run: ${JSON.stringify(ease2)}`)
  log(`HARD.ts currently: units=${HARD.dungeonPowerScale} abs=${absoluteDungeonPowerScale('hard')} sta+${HARD.friendStaminaBonus} fr-${HARD.friendFrightCut}`)
  log(`Friend base clear:     ${pct(pass3.base)}   want ~10%`)
  log(`Friend reroll=6 clear: ${pct(pass3.pFriendMax)}   want ~25%`)
  const frCurve = pass3.rerollPoints.map((r) => `${r.fr}→${pct(r.p)}`).join('  ')
  log(`Friend reroll curve:   ${frCurve}`)

  // Problem flags from last hold-heavy / balanced worlds — re-print key issues
  const bal = ownerWorld(pass3.base, 10_000, 0x4a30b001, { claimer: 0.4, mid: 0.35, holder: 0.25 }, 3, 2, 1.5, 1)
  const hold = ownerWorld(pass3.base, 10_000, 0x4a30b002, { claimer: 0.2, mid: 0.3, holder: 0.5 }, 3, 2, 1.5, 1)
  const early = ownerWorld(pass3.base, 10_000, 0x4a30b003, { claimer: 0.7, mid: 0.2, holder: 0.1 }, 3, 2, 1.5, 1)

  log('\n── Problem check (10k worlds) ──')
  const problems: string[] = []
  if (pass3.base < 0.08 || pass3.base > 0.12) problems.push(`BASE_CLEAR off (${pct(pass3.base)} vs ~10%)`)
  if (pass3.pFriendMax < 0.2 || pass3.pFriendMax > 0.3) problems.push(`REROLL_CAP off (${pct(pass3.pFriendMax)} vs ~25%)`)
  if (bal.survivePerRaid < 0.85 || bal.survivePerRaid > 0.94) problems.push(`SURVIVE off balanced (${pct(bal.survivePerRaid)} vs ~90%)`)
  if (hold.meanFriendPotX < 7.5 || hold.meanFriendPotX > 11) problems.push(`POT off hold-heavy (${hold.meanFriendPotX.toFixed(2)}× vs 8–10)`)
  if (early.meanFriendPotX > 6) problems.push(`EARLY_CLAIM_META pots still ${early.meanFriendPotX.toFixed(2)}× (want collapse toward ~4× — check)`)
  if (bal.meanOwnerRoi < 1.8 || bal.meanOwnerRoi > 3.0) problems.push(`OWNER_ROI balanced ${bal.meanOwnerRoi.toFixed(2)}× (want ~2–2.5)`)
  if (hold.meanOwnerRoi < 1.5) problems.push(`OWNER_ROI hold-heavy starved ${hold.meanOwnerRoi.toFixed(2)}×`)

  log(`balanced: survive ${pct(bal.survivePerRaid)} | Friend pot ${bal.meanFriendPotX.toFixed(2)}× | Owner ROI ${bal.meanOwnerRoi.toFixed(2)}×`)
  log(`hold-heavy: survive ${pct(hold.survivePerRaid)} | Friend pot ${hold.meanFriendPotX.toFixed(2)}× | Owner ROI ${hold.meanOwnerRoi.toFixed(2)}×`)
  log(`early-claim: survive ${pct(early.survivePerRaid)} | Friend pot ${early.meanFriendPotX.toFixed(2)}× | Owner ROI ${early.meanOwnerRoi.toFixed(2)}×`)

  if (problems.length) {
    log('\nPROBLEMS:')
    for (const p of problems) log(`  - ${p}`)
  } else {
    log('\nNo hard break flags — roughly on target for this request.')
  }

  // If ease2 differs from HARD, suggest writing
  if (
    ease2.scale !== absoluteDungeonPowerScale('hard') ||
    ease2.sta !== HARD.friendStaminaBonus ||
    ease2.fright !== HARD.friendFrightCut
  ) {
    log(
      `\nSUGGEST: update HARD combat abs in economy (Soft-units = abs/${DUNGEON_SCALE_UNIT_ABS}) → abs=${ease2.scale} units=${ease2.scale / DUNGEON_SCALE_UNIT_ABS} sta=${ease2.sta} fright=${ease2.fright}`,
    )
  }

  writeFileSync('hard-targets-out.txt', lines.join('\n'), 'utf8')
  console.log('\nWrote hard-targets-out.txt')
}

main()
