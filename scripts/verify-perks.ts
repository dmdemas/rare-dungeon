/**
 * Non-interactive checks that Friend perk ranks change the right stats.
 * Run: npx tsx scripts/verify-perks.ts
 */
import assert from 'node:assert/strict'
import {
  createEmptyPerksState,
  derivePerkMods,
  selectDungeonPerk,
  selectFriendPerk,
  snapshotFriendStats,
  syncRaidWithPerks,
  type DungeonPerkId,
  type FriendPerkId,
} from '../src/game/perks/index.ts'
import { startRaid } from '../src/game/raid.ts'
import { generateBlueprint } from '../src/game/mapGen.ts'

function take(id: FriendPerkId, times = 1) {
  let state = createEmptyPerksState()
  for (let i = 0; i < times; i++) state = selectFriendPerk(state, id)
  return state
}

function takeDungeon(id: DungeonPerkId, times = 1) {
  let state = createEmptyPerksState()
  for (let i = 0; i < times; i++) state = selectDungeonPerk(state, id)
  return state
}

function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`OK  ${name}`)
  } catch (e) {
    console.error(`FAIL ${name}`)
    throw e
  }
}

check('base snapshot', () => {
  const s = snapshotFriendStats(derivePerkMods(createEmptyPerksState()))
  assert.equal(s.vision, 5)
  assert.equal(s.maxStamina, 20)
  assert.equal(s.frightChancePct, 25)
  assert.equal(s.dodgeChancePct, 0)
  assert.equal(s.dashSteps, 0)
})

check('Sharp Eye I/II/III → vision 6/7/8 and flinch −5/−10/−15', () => {
  const i = snapshotFriendStats(derivePerkMods(take('sharpEye', 1)))
  const ii = snapshotFriendStats(derivePerkMods(take('sharpEye', 2)))
  const iii = snapshotFriendStats(derivePerkMods(take('sharpEye', 3)))
  assert.equal(i.vision, 6)
  assert.equal(ii.vision, 7)
  assert.equal(iii.vision, 8)
  assert.equal(i.frightChancePct, 20)
  assert.equal(ii.frightChancePct, 15)
  assert.equal(iii.frightChancePct, 10)
})

check('Endurance I/II/III → STA 22/23/24', () => {
  assert.equal(snapshotFriendStats(derivePerkMods(take('endurance', 1))).maxStamina, 22)
  assert.equal(snapshotFriendStats(derivePerkMods(take('endurance', 2))).maxStamina, 23)
  assert.equal(snapshotFriendStats(derivePerkMods(take('endurance', 3))).maxStamina, 24)
})

check('Fearless I/II/III → fright 0/0/0 from base 25', () => {
  // 25-25=0, 25-50→0 clamp, 25-75→0
  assert.equal(snapshotFriendStats(derivePerkMods(take('fearless', 1))).frightChancePct, 0)
  assert.equal(snapshotFriendStats(derivePerkMods(take('fearless', 2))).frightChancePct, 0)
  assert.equal(snapshotFriendStats(derivePerkMods(take('fearless', 3))).frightChancePct, 0)
})

check('Dodge I/II/III → 25/50/75%', () => {
  assert.equal(snapshotFriendStats(derivePerkMods(take('dodge', 1))).dodgeChancePct, 25)
  assert.equal(snapshotFriendStats(derivePerkMods(take('dodge', 2))).dodgeChancePct, 50)
  assert.equal(snapshotFriendStats(derivePerkMods(take('dodge', 3))).dodgeChancePct, 75)
})

check('Dash I/II/III → 2/3/4 steps', () => {
  assert.equal(snapshotFriendStats(derivePerkMods(take('dash', 1))).dashSteps, 2)
  assert.equal(snapshotFriendStats(derivePerkMods(take('dash', 2))).dashSteps, 3)
  assert.equal(snapshotFriendStats(derivePerkMods(take('dash', 3))).dashSteps, 4)
})

check('Rally I/II/III heal amounts', () => {
  assert.equal(snapshotFriendStats(derivePerkMods(take('rally', 1))).rallyHeal, 2)
  assert.equal(snapshotFriendStats(derivePerkMods(take('rally', 2))).rallyHeal, 2)
  assert.equal(snapshotFriendStats(derivePerkMods(take('rally', 2))).rallyFloorCap, 2)
  assert.equal(snapshotFriendStats(derivePerkMods(take('rally', 3))).rallyHeal, 2)
  assert.equal(snapshotFriendStats(derivePerkMods(take('rally', 3))).rallyFloorCap, null)
})

check('Fog I/II/III → vision −1/−2/−3 and flinch +5/+10/+15', () => {
  const i = snapshotFriendStats(derivePerkMods(takeDungeon('fog', 1)))
  const ii = snapshotFriendStats(derivePerkMods(takeDungeon('fog', 2)))
  const iii = snapshotFriendStats(derivePerkMods(takeDungeon('fog', 3)))
  assert.equal(i.vision, 4)
  assert.equal(ii.vision, 3)
  assert.equal(iii.vision, 2)
  assert.equal(i.frightChancePct, 30)
  assert.equal(ii.frightChancePct, 35)
  assert.equal(iii.frightChancePct, 40)
})

check('syncRaidWithPerks updates live raid VIS/STA', () => {
  const bp = generateBlueprint(42, 'Verify')
  let raid = startRaid(bp)
  assert.equal(raid.friend.vision, 5)
  assert.equal(raid.friend.stamina, 20)

  const perks = take('sharpEye', 2)
  // also endurance II
  const withEnd = selectFriendPerk(selectFriendPerk(perks, 'endurance'), 'endurance')
  raid = syncRaidWithPerks(raid, withEnd)
  assert.equal(raid.friend.vision, 7)
  assert.equal(raid.friend.stamina, 23)
  assert.equal(raid.perkMods.visionBonus, 2)
  assert.equal(raid.perkMods.staminaBonus, 3)
})

console.log('\nAll perk effect checks passed.')
