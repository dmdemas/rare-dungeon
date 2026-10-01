/**
 * Pre-generated dungeon pool for the live app.
 * 50 Soft + 50 Hard pre-seeded dungeons.
 *
 * ── Variance reduction strategy ──────────────────────────────────────────────
 * Blueprint seeds are pre-screened by scripts/calibrate-pool.ts:
 *   - 2 500 candidates per tier, 25 raids each → clearRate estimated
 *   - Only seeds within the target band (15–52% Soft / 4–22% Hard) are kept
 *   - Saved to src/game/approvedSeeds.ts (DO NOT EDIT MANUALLY)
 *   - poolGen picks random seeds from this list → instant generation, no raids
 *
 * If approvedSeeds.ts is missing (not yet generated), falls back to
 * structural-score selection (best-of-10 candidates, σ slightly higher).
 *
 * Re-run calibration after any combat mechanic changes:
 *   npx tsx scripts/calibrate-pool.ts
 */

import { mulberry32, shuffleInPlace } from './rng'
import { generateBlueprint } from './mapGen'
import {
  asSoftDungeon,
  asHardDungeon,
  SOFT,
  HARD,
  ticketMintAtWin,
} from './economy'
import type { DungeonTier } from './economy'
import type { DungeonBlueprint, TileKind } from './types'
import { SOFT_APPROVED_SEEDS, HARD_APPROVED_SEEDS } from './approvedSeeds'

// ── 120 evocative dungeon names ──────────────────────────────────────────────

export const DUNGEON_NAMES: readonly string[] = [
  // Keeps & Fortresses
  'Ashrock Keep', 'Blackfen Vault', 'Coldmoor Bastion', 'Deadstone Fort',
  'Emberveil Hold', 'Frostwall Keep', 'Grimthorn Citadel', 'Hallowed Rampart',
  'Irongate Fortress', 'Jadewing Hold', 'Krovath Stronghold', 'Lorestone Keep',
  'Mournwall Citadel', 'Nightfall Bastion', 'Obsidian Rampart', 'Plagued Fort',
  'Ravenspire Keep', 'Shadowrock Citadel', 'Thornwall Keep', 'Umbral Bastion',
  'Voidwall Fortress', 'Wraithstone Hold', 'Yenvar Keep', 'Zarketh Citadel',
  'Duskwall Keep', 'Grimfell Bastion',
  // Crypts & Tombs
  'Ancient Crypt of Malar', 'Barrow of Lost Souls', 'Cairn of the Undying',
  'Crypt of Eternal Dread', 'Forsaken Barrow', 'Grave of the Fallen',
  'Haunted Mausoleum', 'Icy Tomb of Varak', 'Jade Crypt of Ash',
  'Kingsgrave Vault', 'Lair of Silent Dead', 'Molten Tomb of Goreth',
  'Necrotic Crypt', 'Ossuary of Black Flame', 'Pit of Eternal Rest',
  'Shadowgrave Sanctum', 'Tomb of the Iron King', 'Vault of Shattered Bones',
  'Whisper Crypt of Shar', 'Zereth Barrow',
  // Caverns & Mines
  'Blackrock Cavern', 'Cinderfall Mines', 'Deep Crystal Cave',
  'Emberstone Grotto', 'Flooded Salt Mine', 'Granite Underdepths',
  'Hollow Ash Cave', 'Ironshard Excavation', 'Jagged Rock Cavern',
  'Kethral Mines', 'Lava Vein Grotto', 'Molten Underpit',
  'Nether Crystal Caves', 'Ore Vein Depths', 'Pale Stone Mine',
  'Quartzite Underhall', 'Rumbling Cavern', 'Salt Crystal Depths',
  'Thornstone Grotto', 'Underrock Mines', 'Veiled Fissure', 'Worm-cut Tunnels',
  // Towers & Spires
  'Arcane Spire of Doom', 'Blight Tower', 'Cursed Spire of Ash',
  'Dark Beacon Tower', 'Ebon Spire of Neth', 'Fell Tower of Storms',
  'Ghost Light Spire', 'Hex Tower of Malar', 'Ivory Spire of Ruin',
  'Jade Beacon Tower', 'Killing Tower of Dusk', 'Leaning Spire of Death',
  'Mist-Cloaked Tower', 'Null Spire of Void', 'Omen Tower of Vex',
  'Runed Tower of Pain', 'Shadow Beacon', 'Twilight Spire of Sorrow',
  'Wraithfire Spire', 'Zenith Tower of Ash',
  // Ruins
  'Ancient Ruins of Keth', 'Broken Citadel Ruins', 'Crumbled Fort of Ash',
  'Decrepit Palace Ruin', 'Eroded Temple of Doom', 'Fallen Colossus Ruin',
  'Ghastly Palace Ruin', 'Hollow Temple Ruin', 'Irenvast Ruins',
  'Jagged Ruin of Old', 'Korrath Fallen Keep', 'Lost Temple of Dusk',
  'Molten Ruin of Gor', 'Nameless Ruin of Ash', 'Overgrown Fort Ruin',
  'Petrified Temple Ruin', 'Ruined Hall of Sorrow', 'Sunken Palace Ruin',
  'Toppled Tower Ruin', 'Ulgrath Shattered Keep',
  // Dungeons / Lairs
  'Pit of the Warlord', 'Dungeon of Broken Glass', 'Hall of Gnashing Teeth',
  'Chamber of Creeping Dread', 'Lair of the Stone Eel', 'Hollow of Unrest',
  'Depths of Malgrath', 'Sanctum of the Black Rook', 'Gallery of Ash Masks',
  'Tunnel of Whispering Death', 'Vault of the Shattered Crown', 'Nest of the Pale Crawler',
  'Pit of Forgotten Names', 'Hall of Crimson Tears', 'Domain of Bitter Cold',
  'Archive of Lost Souls', 'Chamber of the Thornlord', 'Hollow of Pale Fire',
]

// ── Structural score fallback ─────────────────────────────────────────────────

const N_CANDIDATES_FALLBACK = 10
const SOFT_TARGET_SCORE = 14
const HARD_TARGET_SCORE = 14
const SCORE_BAND = 4

function structuralScore(tiles: TileKind[], mobSpawns: { x: number; y: number }[], isCorridor: boolean): number {
  const wallCount = tiles.filter(t => t === 'wall').length
  return wallCount + mobSpawns.length * 2 + (isCorridor ? 4 : 0)
}

function pickBestBlueprint(rng: () => number, name: string, targetScore: number): DungeonBlueprint {
  let bestBp: DungeonBlueprint | null = null
  let bestDiff = Infinity
  for (let c = 0; c < N_CANDIDATES_FALLBACK; c++) {
    const mapSeed = (rng() * 0x100000000) >>> 0
    const bp = generateBlueprint(mapSeed, name)
    const diff = Math.abs(structuralScore(bp.map.tiles, bp.mobSpawns, bp.isCorridor ?? false) - targetScore)
    if (diff < bestDiff) { bestDiff = diff; bestBp = bp }
    if (diff <= SCORE_BAND) break
  }
  return bestBp!
}

// ── Ticket power accumulation ────────────────────────────────────────────────

function totalTicketPowerForWins(wins: number): number {
  let total = 0
  for (let k = 1; k <= wins; k++) total += ticketMintAtWin(k)
  return Math.round(total * 1000) / 1000
}

// ── Wins distribution (geometric survival) ───────────────────────────────────

function rollSoftWins(rng: () => number): number {
  let wins = 0
  while (wins < SOFT.maxLiveWins) {
    if (rng() < SOFT.targetClearP) break
    wins++
  }
  return wins
}

function rollHardWins(rng: () => number): number {
  let wins = 0
  while (wins < HARD.maxLiveWins) {
    if (rng() < HARD.targetClearP) break
    wins++
  }
  return wins
}

// ── Create-screen layouts ────────────────────────────────────────────────────

/**
 * Two distinct layouts for the Create screen, drawn from the tier's approved
 * preset pool. The pool itself is fixed; only the draw is random.
 */
export function pickCreatePair(
  tier: DungeonTier,
  seed = (Math.random() * 0x100000000) >>> 0,
): [DungeonBlueprint, DungeonBlueprint] {
  const seeds = tier === 'hard' ? HARD_APPROVED_SEEDS : SOFT_APPROVED_SEEDS
  if (seeds.length < 2) throw new Error(`[poolGen] ${tier} preset pool has ${seeds.length} seeds; run scripts/calibrate-pool.ts`)
  const rng = mulberry32(seed >>> 0)
  const i = Math.floor(rng() * seeds.length)
  let j = Math.floor(rng() * (seeds.length - 1))
  if (j >= i) j++
  return [
    generateBlueprint(seeds[i]!, 'Layout A', tier),
    generateBlueprint(seeds[j]!, 'Layout B', tier),
  ]
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate a live pool of `softCount` Soft + `hardCount` Hard dungeons.
 *
 * PRIMARY PATH (after calibrate-pool.ts has run):
 *   Picks random seeds from src/game/approvedSeeds.ts — INSTANT.
 *   clearRate of every dungeon is guaranteed within the acceptance band.
 *   Expected σ after calibration: ~8–12%.
 *
 * FALLBACK (approvedSeeds.ts not yet generated):
 *   Structural score selection — best-of-10 candidates per slot.
 *   Expected σ: ~18–20% (similar to random).
 *
 * @param seed      Random uint32 for variety across sessions.
 * @param softCount Default 50.
 * @param hardCount Default 50.
 */
export function generateDungeonPool(
  seed: number,
  softCount = 50,
  hardCount = 50,
): DungeonBlueprint[] {
  const rng = mulberry32(seed >>> 0)

  // Shuffle names
  const namePool: string[] = [...DUNGEON_NAMES]
  shuffleInPlace(rng, namePool)
  let nameIdx = 0
  const nextName = () => namePool[nameIdx++ % namePool.length]!

  const pool: DungeonBlueprint[] = []
  const useApproved = SOFT_APPROVED_SEEDS.length >= softCount
                   && HARD_APPROVED_SEEDS.length >= hardCount

  if (useApproved) {
    // ── PRIMARY: approved seed list ──
    const softList = [...SOFT_APPROVED_SEEDS]
    const hardList = [...HARD_APPROVED_SEEDS]
    shuffleInPlace(rng, softList)
    shuffleInPlace(rng, hardList)

    for (let i = 0; i < softCount; i++) {
      const mapSeed = softList[i % softList.length]!
      const wins = rollSoftWins(rng)
      const bank = SOFT.createToBank + wins * SOFT.entryToBank
      const rawBp = generateBlueprint(mapSeed, nextName())
      pool.push(asSoftDungeon({ ...rawBp, wins, bank: Math.round(bank * 100) / 100, invested: SOFT.createCost }))
    }

    for (let i = 0; i < hardCount; i++) {
      const mapSeed = hardList[i % hardList.length]!
      const wins = rollHardWins(rng)
      const bank = HARD.createToBank + wins * HARD.entryToBank
      const ticketPower = totalTicketPowerForWins(wins)
      const rawBp = generateBlueprint(mapSeed, nextName())
      pool.push(asHardDungeon({ ...rawBp, wins, bank: Math.round(bank * 100) / 100, ticketPower, invested: HARD.createCost }))
    }
  } else {
    // ── FALLBACK: structural score selection ──
    console.warn(
      '[poolGen] approvedSeeds.ts not found — using structural fallback.\n' +
      '  Run: npx tsx scripts/calibrate-pool.ts  to generate approved seeds.'
    )

    for (let i = 0; i < softCount; i++) {
      const wins = rollSoftWins(rng)
      const bank = SOFT.createToBank + wins * SOFT.entryToBank
      const rawBp = pickBestBlueprint(rng, nextName(), SOFT_TARGET_SCORE)
      pool.push(asSoftDungeon({ ...rawBp, wins, bank: Math.round(bank * 100) / 100, invested: SOFT.createCost }))
    }

    for (let i = 0; i < hardCount; i++) {
      const wins = rollHardWins(rng)
      const bank = HARD.createToBank + wins * HARD.entryToBank
      const ticketPower = totalTicketPowerForWins(wins)
      const rawBp = pickBestBlueprint(rng, nextName(), HARD_TARGET_SCORE)
      pool.push(asHardDungeon({ ...rawBp, wins, bank: Math.round(bank * 100) / 100, ticketPower, invested: HARD.createCost }))
    }
  }

  return pool
}
