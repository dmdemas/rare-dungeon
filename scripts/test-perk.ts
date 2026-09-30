/**
 * Terminal Friend-perk sandbox.
 *
 * Start:  npm run test:perk
 * Then:   test perk
 * Perks:  fearless | dash | sharpeye | endurance | rally | dodge
 * Upgrade last pick: upgrade
 * Quit:   quit
 */
import * as readline from 'node:readline'
import {
  createEmptySideState,
  derivePerkMods,
  getPerkDef,
  nextRankAfterPick,
  selectPerk,
  snapshotFriendStats,
  type FriendPerkId,
  type SidePerkState,
} from '../src/game/perks/index.ts'

const ALIASES: Record<string, FriendPerkId> = {
  fearless: 'fearless',
  dash: 'dash',
  sharpeye: 'sharpEye',
  'sharp-eye': 'sharpEye',
  'sharp_eye': 'sharpEye',
  eye: 'sharpEye',
  endurance: 'endurance',
  rally: 'rally',
  dodge: 'dodge',
}

type Session = {
  friend: SidePerkState<FriendPerkId>
  lastPick: FriendPerkId | null
  active: boolean
}

function printStats(session: Session, banner: string) {
  const mods = derivePerkMods({
    friend: session.friend,
    dungeon: createEmptySideState(),
  })
  const s = snapshotFriendStats(mods)
  const mark = (n: number) => (n === 0 ? '—' : n === 1 ? 'I' : n === 2 ? 'II' : 'III')
  const r = session.friend.ranks
  console.log('')
  console.log(`=== ${banner} ===`)
  console.log(`Attack:        ${s.attack}`)
  console.log(`Vision:        ${s.vision}`)
  console.log(`Max stamina:   ${s.maxStamina}`)
  console.log(`Fright chance: ${s.frightChancePct}%`)
  console.log(`Dodge chance:  ${s.dodgeChancePct}%`)
  console.log(`Dash steps:    ${s.dashSteps || '—'}`)
  console.log(
    `Rally:         heal ${s.rallyHeal || 0}` +
      (s.rallyFloorCap != null ? `, floor cap ${s.rallyFloorCap}` : s.rallyHeal ? ', no floor cap' : ''),
  )
  console.log('--- perk ranks ---')
  console.log(
    `Fearless ${mark(r.fearless ?? 0)} | Dash ${mark(r.dash ?? 0)} | Sharp Eye ${mark(r.sharpEye ?? 0)} | Endurance ${mark(r.endurance ?? 0)} | Rally ${mark(r.rally ?? 0)} | Dodge ${mark(r.dodge ?? 0)}`,
  )
  console.log('')
}

function printHelp() {
  console.log(`
Commands:
  test perk          start / reset Friend sandbox + print base stats
  fearless           take / upgrade Fearless
  dash               take / upgrade Dash
  sharpeye           take / upgrade Sharp Eye
  endurance          take / upgrade Endurance
  rally              take / upgrade Rally
  dodge              take / upgrade Dodge
  upgrade            upgrade the last perk you took one rank
  stats              print current stats again
  help               this list
  quit               exit
`)
}

function applyPerk(session: Session, id: FriendPerkId): string | null {
  const nextRank = nextRankAfterPick(session.friend.ranks, id)
  if (nextRank === null) {
    return `${getPerkDef(id).name} is already III — cannot upgrade.`
  }
  session.friend = selectPerk(session.friend, id)
  session.lastPick = id
  const def = getPerkDef(id)
  const mark = nextRank === 1 ? 'I' : nextRank === 2 ? 'II' : 'III'
  return `Applied ${def.name} → ${mark}`
}

async function main() {
  const session: Session = {
    friend: createEmptySideState(),
    lastPick: null,
    active: false,
  }

  console.log('Friend perk sandbox. Type "test perk" to start, "help" for commands.')

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const ask = () =>
    new Promise<string>((resolve) => {
      rl.question('> ', (line) => resolve(line.trim()))
    })

  while (true) {
    const line = await ask()
    if (!line) continue
    const cmd = line.toLowerCase().replace(/\s+/g, ' ')

    if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') {
      rl.close()
      break
    }

    if (cmd === 'help' || cmd === '?') {
      printHelp()
      continue
    }

    if (cmd === 'test perk' || cmd === 'testperk' || cmd === 'start demo' || cmd === 'start') {
      session.friend = createEmptySideState()
      session.lastPick = null
      session.active = true
      printStats(session, 'Friend stats (base)')
      continue
    }

    if (!session.active) {
      console.log('Session not started. Type: test perk')
      continue
    }

    if (cmd === 'stats' || cmd === 'status') {
      printStats(session, 'Friend stats')
      continue
    }

    if (cmd === 'upgrade' || cmd === 'up') {
      if (!session.lastPick) {
        console.log('No last perk to upgrade. Take a perk first (e.g. fearless).')
        continue
      }
      const msg = applyPerk(session, session.lastPick)
      console.log(msg)
      printStats(session, 'Friend stats (after upgrade)')
      continue
    }

    const id = ALIASES[cmd]
    if (id) {
      const msg = applyPerk(session, id)
      console.log(msg)
      if (!msg?.includes('already III')) {
        printStats(session, `Friend stats (after ${getPerkDef(id).name})`)
      }
      continue
    }

    console.log(`Unknown command: ${line}`)
    printHelp()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
