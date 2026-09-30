/**
 * Soft/Hard economy + owner share pool from entries & rerolls.
 *
 * Hierarchy: Soft Friend WR > Hard Friend WR (even at Hard reroll cap).
 * Pool: 20% Soft owners / 80% Hard owners, pro-rata by live dungeon count.
 *
 *   npx tsx scripts/sim-economy-tiers.ts
 */

type Tier = 'soft' | 'hard'

interface TierCfg {
  name: Tier
  createCost: number
  /** Portion of create that seeds the raidable bank. */
  createToBank: number
  createFee: number
  entryCost: number
  /**
   * Split of each entry:
   * - toBank: fatten THIS dungeon (clear fantasy)
   * - toOwnerPool: global epoch pool → 20/80 Soft/Hard owners
   * - toProtocol: burn+treasure (house)
   */
  entryToBank: number
  entryToOwnerPool: number
  entryToProtocol: number
  baseClearP: number
  cappedClearP: number
  fracAnyReroll: number
  fracMaxReroll: number
  meanRerollSpendIfReroll: number
  meanCreateRerollSpend: number
  clearPayoutFrac: number
  clearFeeFrac: number
  closeOwnerFrac: (wins: number) => number
  /** Owner closes when bank reaches this (claim bank, lose future shares). */
  closeBankTarget: number
  winCap: number
  /** How many epochs a dungeon stays open if not cleared/closed early (hold strategy). */
  targetHoldEpochs: number
}

const SOFT: TierCfg = {
  name: 'soft',
  createCost: 2,
  createToBank: 1.5,
  createFee: 0.5,
  entryCost: 1,
  // Hybrid: keep some bank fantasy, rest pays holders
  entryToBank: 0.35,
  entryToOwnerPool: 0.55,
  entryToProtocol: 0.1,
  baseClearP: 0.32,
  cappedClearP: 0.32,
  fracAnyReroll: 0,
  fracMaxReroll: 0,
  meanRerollSpendIfReroll: 0,
  meanCreateRerollSpend: 0,
  clearPayoutFrac: 0.95,
  clearFeeFrac: 0.05,
  closeOwnerFrac: (w) => (w <= 3 ? 0.92 : 0.94),
  closeBankTarget: 4.5,
  winCap: 15,
  targetHoldEpochs: 8,
}

const HARD: TierCfg = {
  name: 'hard',
  createCost: 20,
  createToBank: 10,
  createFee: 10,
  entryCost: 10,
  entryToBank: 3.5,
  entryToOwnerPool: 5.5,
  entryToProtocol: 1,
  baseClearP: 0.07,
  cappedClearP: 0.2, // must stay < Soft 0.32
  fracAnyReroll: 0.5,
  fracMaxReroll: 0.18,
  meanRerollSpendIfReroll: 5,
  meanCreateRerollSpend: 6,
  clearPayoutFrac: 0.95,
  clearFeeFrac: 0.05,
  closeOwnerFrac: (w) => {
    if (w <= 4) return 0.85
    if (w <= 7) return 0.88
    if (w <= 11) return 0.92
    return 0.95
  },
  closeBankTarget: 55,
  winCap: 40,
  targetHoldEpochs: 20,
}

/** Pure pool variant (user literal): 100% entry → owner pool, bank = create only. */
const SOFT_PURE_POOL: TierCfg = {
  ...SOFT,
  entryToBank: 0,
  entryToOwnerPool: 0.9,
  entryToProtocol: 0.1,
  closeBankTarget: 1.5, // only create stake — early claim useless; hold for shares
}

const HARD_PURE_POOL: TierCfg = {
  ...HARD,
  entryToBank: 0,
  entryToOwnerPool: 9,
  entryToProtocol: 1,
  closeBankTarget: 999, // never close for bank; income = shares only until cleared
}

const POOL_SOFT_SHARE = 0.2
const POOL_HARD_SHARE = 0.8

function mulberry32(a: number): () => number {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function raidClearP(cfg: TierCfg, rng: () => number): { p: number; reroll: number } {
  if (cfg.name === 'soft') return { p: cfg.baseClearP, reroll: 0 }
  if (rng() >= cfg.fracAnyReroll) return { p: cfg.baseClearP, reroll: 0 }
  const toCap = rng() < cfg.fracMaxReroll / Math.max(cfg.fracAnyReroll, 1e-9)
  const u = toCap ? 1 : 0.35 + rng() * 0.45
  const p = cfg.baseClearP + (cfg.cappedClearP - cfg.baseClearP) * u
  const reroll = cfg.meanRerollSpendIfReroll * (0.6 + rng() * 0.8) * (toCap ? 1.35 : 1)
  return { p, reroll }
}

type LiveDungeon = {
  id: number
  tier: Tier
  cfg: TierCfg
  bank: number
  kills: number
  ownerId: number
  createRerollPaid: number
  alive: boolean
  endedBy?: 'clear' | 'close' | 'cap'
  ownerBankPayout: number
  shareIncome: number
  epochsLived: number
}

type Owner = {
  id: number
  softCreates: number
  hardCreates: number
}

/**
 * Multi-owner world sim:
 * - N owners create some Soft/Hard dungeons
 * - Each epoch: R raids hit random live dungeons of matching demand
 * - Entry+reroll → ownerPool; epoch end: 20/80 split by live counts
 * - Owners with "hold" policy keep dungeons until clear/cap; "claimy" close at bank target
 */
function simulateWorld(opts: {
  label: string
  soft: TierCfg
  hard: TierCfg
  owners: number
  softPerOwner: number
  hardPerOwner: number
  epochs: number
  raidsPerEpoch: number
  softRaidFrac: number
  /** 0 = always hold for shares; 1 = always close at bank target */
  claimyFrac: number
  seed: number
}) {
  const rng = mulberry32(opts.seed)
  const owners: Owner[] = Array.from({ length: opts.owners }, (_, i) => ({
    id: i,
    softCreates: opts.softPerOwner,
    hardCreates: opts.hardPerOwner,
  }))

  const dungeons: LiveDungeon[] = []
  let id = 0
  let protocol = 0
  let weekTicketsPool = 0 // clear fees still can feed tickets; separate from owner share pool
  let ownerPoolCollected = 0
  let ownerPoolPaid = 0

  for (const o of owners) {
    for (let i = 0; i < o.softCreates; i++) {
      const createReroll = 0
      protocol += opts.soft.createFee
      dungeons.push({
        id: id++,
        tier: 'soft',
        cfg: opts.soft,
        bank: opts.soft.createToBank,
        kills: 0,
        ownerId: o.id,
        createRerollPaid: createReroll,
        alive: true,
        ownerBankPayout: 0,
        shareIncome: 0,
        epochsLived: 0,
      })
    }
    for (let i = 0; i < o.hardCreates; i++) {
      const createReroll = opts.hard.meanCreateRerollSpend * (0.5 + rng())
      protocol += opts.hard.createFee
      ownerPoolCollected += createReroll // create perk rerolls → same owner pool
      dungeons.push({
        id: id++,
        tier: 'hard',
        cfg: opts.hard,
        bank: opts.hard.createToBank,
        kills: 0,
        ownerId: o.id,
        createRerollPaid: createReroll,
        alive: true,
        ownerBankPayout: 0,
        shareIncome: 0,
        epochsLived: 0,
      })
    }
  }

  const isClaimy = owners.map(() => rng() < opts.claimyFrac)

  let softRaids = 0
  let hardRaids = 0
  let softClears = 0
  let hardClears = 0
  let softClose = 0
  let hardClose = 0
  let sumSoftClearP = 0
  let sumHardClearP = 0

  for (let ep = 0; ep < opts.epochs; ep++) {
    let epochPool = 0

    for (let r = 0; r < opts.raidsPerEpoch; r++) {
      const wantSoft = rng() < opts.softRaidFrac
      const live = dungeons.filter((d) => d.alive && d.tier === (wantSoft ? 'soft' : 'hard'))
      if (live.length === 0) {
        // spill to other tier
        const any = dungeons.filter((d) => d.alive)
        if (any.length === 0) break
        live.push(...any)
      }
      const d = live[Math.floor(rng() * live.length)]!
      const cfg = d.cfg
      if (d.tier === 'soft') softRaids++
      else hardRaids++

      const { p, reroll } = raidClearP(cfg, rng)
      if (d.tier === 'soft') sumSoftClearP += p
      else sumHardClearP += p

      // Entry split
      d.bank += cfg.entryToBank
      epochPool += cfg.entryToOwnerPool + reroll
      protocol += cfg.entryToProtocol

      if (rng() < p) {
        // Clear
        const pay = d.bank * cfg.clearPayoutFrac
        protocol += d.bank * cfg.clearFeeFrac
        weekTicketsPool += d.bank * cfg.clearFeeFrac * 0.5 // illustrative
        d.alive = false
        d.endedBy = 'clear'
        d.ownerBankPayout = 0
        if (d.tier === 'soft') softClears++
        else hardClears++
        continue
      }

      d.kills++
      // Claimy owners may close after kill if bank target hit
      if (isClaimy[d.ownerId] && d.bank >= cfg.closeBankTarget) {
        const frac = cfg.closeOwnerFrac(d.kills)
        d.ownerBankPayout = d.bank * frac
        protocol += d.bank - d.ownerBankPayout
        d.alive = false
        d.endedBy = 'close'
        if (d.tier === 'soft') softClose++
        else hardClose++
        continue
      }
      if (d.kills >= cfg.winCap) {
        const frac = cfg.closeOwnerFrac(d.kills)
        d.ownerBankPayout = d.bank * frac
        protocol += d.bank - d.ownerBankPayout
        d.alive = false
        d.endedBy = 'cap'
        if (d.tier === 'soft') softClose++
        else hardClose++
      }
    }

    // Epoch share payout: 20% soft / 80% hard by live count
    const liveSoft = dungeons.filter((d) => d.alive && d.tier === 'soft')
    const liveHard = dungeons.filter((d) => d.alive && d.tier === 'hard')
    const softPot = epochPool * POOL_SOFT_SHARE
    const hardPot = epochPool * POOL_HARD_SHARE
    ownerPoolCollected += epochPool

    if (liveSoft.length) {
      const per = softPot / liveSoft.length
      for (const d of liveSoft) {
        d.shareIncome += per
        d.epochsLived++
      }
      ownerPoolPaid += softPot
    } else {
      // rollover to hard if no soft live
      if (liveHard.length) {
        const per = softPot / liveHard.length
        for (const d of liveHard) d.shareIncome += per
        ownerPoolPaid += softPot
      }
    }
    if (liveHard.length) {
      const per = hardPot / liveHard.length
      for (const d of liveHard) {
        d.shareIncome += per
        d.epochsLived++
      }
      ownerPoolPaid += hardPot
    } else if (liveSoft.length) {
      const per = hardPot / liveSoft.length
      for (const d of liveSoft) d.shareIncome += per
      ownerPoolPaid += hardPot
    }

    // Holders: optional auto-close after targetHoldEpochs if bank also fat (hybrid only)
    for (const d of dungeons) {
      if (!d.alive) continue
      if (isClaimy[d.ownerId]) continue
      if (d.epochsLived >= d.cfg.targetHoldEpochs && d.bank >= d.cfg.closeBankTarget * 0.85) {
        const frac = d.cfg.closeOwnerFrac(d.kills)
        d.ownerBankPayout = d.bank * frac
        protocol += d.bank - d.ownerBankPayout
        d.alive = false
        d.endedBy = 'close'
        if (d.tier === 'soft') softClose++
        else hardClose++
      }
    }
  }

  // Force-close leftovers for accounting
  for (const d of dungeons) {
    if (!d.alive) continue
    const frac = d.cfg.closeOwnerFrac(d.kills)
    d.ownerBankPayout = d.bank * frac
    protocol += d.bank - d.ownerBankPayout
    d.alive = false
    d.endedBy = 'close'
  }

  const byOwner = new Map<number, { createSpent: number; bank: number; shares: number; nSoft: number; nHard: number }>()
  for (const o of owners) {
    byOwner.set(o.id, {
      createSpent: o.softCreates * opts.soft.createCost + o.hardCreates * opts.hard.createCost,
      bank: 0,
      shares: 0,
      nSoft: o.softCreates,
      nHard: o.hardCreates,
    })
  }
  for (const d of dungeons) {
    const row = byOwner.get(d.ownerId)!
    row.bank += d.ownerBankPayout
    row.shares += d.shareIncome
    row.createSpent += d.createRerollPaid
  }

  const profits = [...byOwner.values()].map((r) => r.bank + r.shares - r.createSpent)
  const softD = dungeons.filter((d) => d.tier === 'soft')
  const hardD = dungeons.filter((d) => d.tier === 'hard')
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

  console.log(`\n======== WORLD: ${opts.label} ========`)
  console.log(
    `Owners=${opts.owners} soft/owner=${opts.softPerOwner} hard/owner=${opts.hardPerOwner} epochs=${opts.epochs} raids/ep=${opts.raidsPerEpoch} claimy=${opts.claimyFrac}`,
  )
  console.log(
    `Entry split Soft bank/pool/proto=${opts.soft.entryToBank}/${opts.soft.entryToOwnerPool}/${opts.soft.entryToProtocol} | Hard ${opts.hard.entryToBank}/${opts.hard.entryToOwnerPool}/${opts.hard.entryToProtocol}`,
  )
  console.log(
    `WR targets Soft=${opts.soft.baseClearP} Hard base/cap=${opts.hard.baseClearP}/${opts.hard.cappedClearP}`,
  )
  console.log(
    `Raids soft=${softRaids} hard=${hardRaids} | meanClearP soft=${softRaids ? (sumSoftClearP / softRaids).toFixed(3) : '—'} hard=${hardRaids ? (sumHardClearP / hardRaids).toFixed(3) : '—'}`,
  )
  console.log(
    `Dungeon ends Soft clear/close=${softClears}/${softClose} | Hard clear/close=${hardClears}/${hardClose}`,
  )
  console.log(
    `Per Soft dungeon: mean bankClaim=$${mean(softD.map((d) => d.ownerBankPayout)).toFixed(2)} mean shares=$${mean(softD.map((d) => d.shareIncome)).toFixed(2)} mean kills=${mean(softD.map((d) => d.kills)).toFixed(2)}`,
  )
  console.log(
    `Per Hard dungeon: mean bankClaim=$${mean(hardD.map((d) => d.ownerBankPayout)).toFixed(2)} mean shares=$${mean(hardD.map((d) => d.shareIncome)).toFixed(2)} mean kills=${mean(hardD.map((d) => d.kills)).toFixed(2)}`,
  )
  console.log(
    `Owner profit (bank+shares-create): mean=$${mean(profits).toFixed(2)}  P(+)=${((100 * profits.filter((p) => p > 0).length) / profits.length).toFixed(1)}%`,
  )
  console.log(
    `Owner pool collected=$${ownerPoolCollected.toFixed(0)} paid=$${ownerPoolPaid.toFixed(0)} | protocol≈$${protocol.toFixed(0)}`,
  )

  // Hold vs claimy EV
  const holdProf: number[] = []
  const claimProf: number[] = []
  for (const o of owners) {
    const row = byOwner.get(o.id)!
    const p = row.bank + row.shares - row.createSpent
    if (isClaimy[o.id]) claimProf.push(p)
    else holdProf.push(p)
  }
  console.log(
    `Strategy EV: HOLD mean=$${mean(holdProf).toFixed(2)} (n=${holdProf.length}) | CLAIMY mean=$${mean(claimProf).toFixed(2)} (n=${claimProf.length})`,
  )

  return {
    softMeanP: softRaids ? sumSoftClearP / softRaids : 0,
    hardMeanP: hardRaids ? sumHardClearP / hardRaids : 0,
    holdMean: mean(holdProf),
    claimyMean: mean(claimProf),
  }
}

function main() {
  console.log('Invariant: Soft Friend WR (32%) > Hard max reroll WR (20%) > Hard base (7%)')
  console.log('Owner pool split: 20% Soft live shares / 80% Hard live shares')
  console.log('Motivation: more live Hard dungeons → more share income; closing early loses shares\n')

  const hybrid = simulateWorld({
    label: 'HYBRID entry (bank + owner pool) — RECOMMENDED',
    soft: SOFT,
    hard: HARD,
    owners: 40,
    softPerOwner: 1,
    hardPerOwner: 1,
    epochs: 30,
    raidsPerEpoch: 80,
    softRaidFrac: 0.55,
    claimyFrac: 0.35,
    seed: 0x41b10001,
  })

  const pure = simulateWorld({
    label: 'PURE pool (100% entry → owners, bank=create only)',
    soft: SOFT_PURE_POOL,
    hard: HARD_PURE_POOL,
    owners: 40,
    softPerOwner: 1,
    hardPerOwner: 1,
    epochs: 30,
    raidsPerEpoch: 80,
    softRaidFrac: 0.55,
    claimyFrac: 0.35,
    seed: 0x41b10002,
  })

  const farmSoft = simulateWorld({
    label: 'SOFT-FARM stress (3 soft + 0 hard per owner)',
    soft: SOFT,
    hard: HARD,
    owners: 40,
    softPerOwner: 3,
    hardPerOwner: 0,
    epochs: 30,
    raidsPerEpoch: 80,
    softRaidFrac: 0.7,
    claimyFrac: 0.2,
    seed: 0x41b10003,
  })

  const heavyHard = simulateWorld({
    label: 'HARD-HEAVY (0 soft + 2 hard) hold incentive',
    soft: SOFT,
    hard: HARD,
    owners: 30,
    softPerOwner: 0,
    hardPerOwner: 2,
    epochs: 30,
    raidsPerEpoch: 60,
    softRaidFrac: 0.15,
    claimyFrac: 0.25,
    seed: 0x41b10004,
  })

  console.log('\n----- Hierarchy & hold check -----')
  console.log(
    `Hybrid Soft p ${hybrid.softMeanP.toFixed(3)} > Hard p ${hybrid.hardMeanP.toFixed(3)} ? ${hybrid.softMeanP > hybrid.hardMeanP}`,
  )
  console.log(
    `Hybrid HOLD EV $${hybrid.holdMean.toFixed(2)} vs CLAIMY $${hybrid.claimyMean.toFixed(2)} (want HOLD ≥ CLAIMY)`,
  )
  console.log(
    `Pure HOLD $${pure.holdMean.toFixed(2)} vs CLAIMY $${pure.claimyMean.toFixed(2)}`,
  )
  console.log(`Soft-farm owner mean profit context above; Hard-heavy HOLD $${heavyHard.holdMean.toFixed(2)}`)
}

main()
