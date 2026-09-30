import type {
  DungeonPerkId,
  FriendPerkId,
  PerkDef,
  PerkId,
  PerkSide,
} from './types'

const FRIEND_DIR = 'assets/refs.perk/PerksFriend'
const DUNGEON_DIR = 'assets/refs.perk/PerksDungeon'

/** Filenames as they exist on disk — match by name, never swap art. */
export const FRIEND_PERKS: readonly PerkDef<FriendPerkId>[] = [
  {
    id: 'fearless',
    side: 'friend',
    name: 'Fearless',
    type: 'Defense',
    rule: 'Reduces the chance to flinch back from a monster. Fear can go to 0%. Hop length from total fear: ≤25% → 1 cell; above 25% (incl. >50%) → 2 cells.',
    ranks: ['−25%', '−50%', '−75%'],
    iconPath: `${FRIEND_DIR}/Fearless.png`,
  },
  {
    id: 'dash',
    side: 'friend',
    name: 'Dash',
    type: 'Mobility',
    rule: 'After taking damage, move toward the exit without spending stamina. Cannot enter a wall or a monster. Once per hit.',
    ranks: ['2 steps', '3 steps', '4 steps'],
    iconPath: `${FRIEND_DIR}/Dash.png`,
  },
  {
    id: 'sharpEye',
    side: 'friend',
    name: 'Sharp Eye',
    type: 'Vision',
    rule: 'Increases vision range and reduces the chance to flinch from a monster. Vision cannot drop below 1.',
    ranks: ['+1 vision, −15% flinch', '+2 vision, −30% flinch', '+3 vision, −45% flinch'],
    iconPath: `${FRIEND_DIR}/SharpEye.png`,
  },
  {
    id: 'endurance',
    side: 'friend',
    name: 'Endurance',
    type: 'Stamina',
    rule: 'Raises max stamina. Only the current rank applies.',
    ranks: ['+2', '+3', '+4'],
    iconPath: `${FRIEND_DIR}/Endurance.png`,
  },
  {
    id: 'rally',
    side: 'friend',
    name: 'Rally',
    type: 'Recovery',
    rule: 'Restore stamina when a monster dies. Cannot go above max stamina.',
    ranks: ['+1, max 2 times per floor', '+2, max 2 times per floor', '+3, max 2 times per floor'],
    iconPath: `${FRIEND_DIR}/Rally.png`,
  },
  {
    id: 'dodge',
    side: 'friend',
    name: 'Dodge',
    type: 'Defense',
    rule: 'Chance to ignore a monster hit. No free step. No skipped tick.',
    ranks: ['35%', '55%', '75%'],
    iconPath: `${FRIEND_DIR}/Dodge.png`,
  },
] as const

export const DUNGEON_PERKS: readonly PerkDef<DungeonPerkId>[] = [
  {
    id: 'dreadfulBeasts',
    side: 'dungeon',
    name: 'Dreadful Beasts',
    type: 'Control',
    rule: 'Increases the chance Friend flinches back. Total fear chance is capped at 95%. Hop length from total fear: ≤25% → 1 cell; above 25% (incl. >50%) → 2 cells.',
    ranks: ['+25%', '+50%', '+75%'],
    iconPath: `${DUNGEON_DIR}/DreadfulBeasts.png`,
  },
  {
    id: 'sharpClaws',
    side: 'dungeon',
    name: 'Sharp Claws',
    type: 'Offense',
    rule: 'All monsters deal extra damage.',
    ranks: ['+1', '+2', '+2'],
    iconPath: `${DUNGEON_DIR}/SharpClaws.png`,
  },
  {
    id: 'fog',
    side: 'dungeon',
    name: 'Fog',
    type: 'Vision',
    rule: 'Shortens Friend’s vision and raises the chance Friend flinches from a monster. Vision cannot drop below 1. Total fear chance is capped at 95%.',
    ranks: ['−1 vision, +15% flinch', '−2 vision, +30% flinch', '−3 vision, +45% flinch'],
    iconPath: `${DUNGEON_DIR}/Fog.png`,
  },
  {
    id: 'thickHide',
    side: 'dungeon',
    name: 'Thick Hide',
    type: 'Defense',
    rule: 'All monsters gain extra HP.',
    ranks: ['+1', '+2', '+3'],
    iconPath: `${DUNGEON_DIR}/ThickHide.png`,
  },
  {
    id: 'walls',
    side: 'dungeon',
    name: 'Pits',
    type: 'Map',
    rule: 'Adds extra pit cells. Never on entrance, exit, monsters, or the only path. A route to the exit must remain. Pits are rolled once and stay fixed on the map.',
    ranks: ['4–6', '6–8', '8–10'],
    iconPath: `${DUNGEON_DIR}/walls.png`,
  },
  {
    id: 'horde',
    side: 'dungeon',
    name: 'Horde',
    type: 'Spawn',
    rule: 'Adds extra monsters on free floor tiles. Not on entrance, exit, or the only corridor.',
    ranks: ['+1', '2–3 (50%)', '2–3 (50%)'],
    iconPath: `${DUNGEON_DIR}/Horde.png`,
  },
] as const

export const FRIEND_PERK_IDS = FRIEND_PERKS.map((p) => p.id)
export const DUNGEON_PERK_IDS = DUNGEON_PERKS.map((p) => p.id)

const BY_ID: Record<PerkId, PerkDef> = {
  ...Object.fromEntries(FRIEND_PERKS.map((p) => [p.id, p])),
  ...Object.fromEntries(DUNGEON_PERKS.map((p) => [p.id, p])),
} as Record<PerkId, PerkDef>

export function getPerkDef(id: PerkId): PerkDef {
  return BY_ID[id]
}

export function poolFor(side: PerkSide): readonly PerkDef[] {
  return side === 'friend' ? FRIEND_PERKS : DUNGEON_PERKS
}

export function idsFor(side: PerkSide): readonly PerkId[] {
  return side === 'friend' ? FRIEND_PERK_IDS : DUNGEON_PERK_IDS
}
