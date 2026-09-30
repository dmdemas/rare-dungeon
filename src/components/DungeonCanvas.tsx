import { useEffect, useRef, useState } from 'react'
import { MAP_H, MAP_W } from '../game/config'
import { isCurrentlyVisible, sharpEyeRing } from '../game/fog'
import {
  REF,
  cellCenter,
  cellQuad,
  fitRefCamera,
  mapQuad,
  mapRefToCanvas,
  rowEdge,
  type Pt,
} from '../game/gridGeom'
import { tileAt, chebyshev } from '../game/pathfinding'
import type { Cell, RaidState, TileKind } from '../game/types'
import { cellKey } from '../game/types'

export type JumpAnim = {
  friendFrom: Cell
  friendTo: Cell
  mobs: { id: number; from: Cell; to: Cell }[]
  /** 0..1 during jump */
  t: number
}

/** Purple afterimage cells left by Dash free steps. */
export type DashTrailCell = {
  x: number
  y: number
  opacity: number
}

type FogEyePair = {
  x: number
  y: number
  born: number
  /** How long the pair stays visible (ms). */
  life: number
  /** If set, eyes track this living mob under the fog. */
  mobId?: number
}

type Props = {
  raid: RaidState
  highlights?: Cell[]
  jumpAnim?: JumpAnim | null
  friendHurt?: boolean
  /** Mob id currently flashing red from damage (clears next turn). */
  hurtMobId?: number | null
  /** Dash speed-trail cells (purple particles). */
  dashTrail?: DashTrailCell[]
  /** Endurance: blue ward while bonus STA remains. */
  enduranceShield?: boolean
  /** Endurance break flash 0..1 (light burst when bonus STA is spent). */
  enduranceBreakT?: number
  /** Increments when Rally heals — purple confetti burst around Friend. */
  rallyBurstId?: number
  /** Purple flags planted on Rally (persist for the current floor only; visual only). */
  rallyFlags?: Cell[]
  /** Increments when Friend dodges — duck squash VFX. */
  dodgeBurstId?: number
  /** Increments when Sharp Claws hits Friend — three-claw slash on Friend cell. */
  clawsBurstId?: number
  boardOpacity?: number
  /** Pit fade-out variant (1–5) for floor-adjacent walls. */
  pitCliffStyle?: 1 | 2 | 3 | 4 | 5
  /** Demo: no fog, full grid visible. */
  revealAll?: boolean
  /**
   * Create / inspect: full map stays visible, but Fog perk still animates
   * (veil + eyes) at reduced opacity — top-down preview.
   */
  liteFogPreview?: boolean
  width?: number
  height?: number
}

/** Darker gray floor (geometry unchanged). */
const FLOOR_FILL = '#3a3a3a'
const FLOOR_STROKE = 'rgba(210,210,210,0.9)'
const ENTRANCE_FILL = '#2f6b3a'
const ENTRANCE_STROKE = 'rgba(120,220,140,0.95)'
const EXIT_FILL = '#4a4a52'
const EXIT_STROKE = 'rgba(220,200,120,0.95)'
const EXIT_MARK = 'rgba(230,210,100,0.55)'

/** Sharp Eye bonus rings — farther = stronger green. */
const SHARP_EYE_GLOW: Record<1 | 2 | 3, string> = {
  1: 'rgba(90, 200, 110, 0.16)',
  2: 'rgba(70, 230, 100, 0.28)',
  3: 'rgba(45, 255, 95, 0.42)',
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function easeJump(t: number) {
  return t * t * (3 - 2 * t)
}

function fillQuad(
  ctx: CanvasRenderingContext2D,
  q: [Pt, Pt, Pt, Pt],
  style: string | CanvasGradient | CanvasPattern,
) {
  ctx.fillStyle = style
  ctx.beginPath()
  ctx.moveTo(q[0].x, q[0].y)
  ctx.lineTo(q[1].x, q[1].y)
  ctx.lineTo(q[2].x, q[2].y)
  ctx.lineTo(q[3].x, q[3].y)
  ctx.closePath()
  ctx.fill()
}

function strokeQuad(ctx: CanvasRenderingContext2D, q: [Pt, Pt, Pt, Pt], style: string, lineWidth: number) {
  ctx.strokeStyle = style
  ctx.lineWidth = lineWidth
  ctx.lineJoin = 'miter'
  ctx.beginPath()
  ctx.moveTo(q[0].x, q[0].y)
  ctx.lineTo(q[1].x, q[1].y)
  ctx.lineTo(q[2].x, q[2].y)
  ctx.lineTo(q[3].x, q[3].y)
  ctx.closePath()
  ctx.stroke()
}

function extendToY(a: Pt, b: Pt, yTarget: number): Pt {
  const dy = b.y - a.y
  if (Math.abs(dy) < 1e-6) return { x: b.x, y: yTarget }
  const t = (yTarget - a.y) / dy
  return { x: a.x + (b.x - a.x) * t, y: yTarget }
}

/**
 * Canonical front apron (Grid Demo C): rails follow floor edges to canvas bottom,
 * gradient fade-out + underside deck.
 */
function drawPlatform(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  fit: number,
  canvasH: number,
) {
  const near = rowEdge(0)
  const far = rowEdge(1)
  const fl = mapRefToCanvas({ x: far.left, y: far.y }, ox, oy, fit)
  const fr = mapRefToCanvas({ x: far.right, y: far.y }, ox, oy, fit)
  const nl = mapRefToCanvas({ x: near.left, y: near.y }, ox, oy, fit)
  const nr = mapRefToCanvas({ x: near.right, y: near.y }, ox, oy, fit)

  const botY = canvasH + 2
  const bl = extendToY(fl, nl, botY)
  const br = extendToY(fr, nr, botY)

  const grad = ctx.createLinearGradient(0, nl.y, 0, botY)
  grad.addColorStop(0, '#2e2e2e')
  grad.addColorStop(0.4, '#181818')
  grad.addColorStop(1, '#050505')

  ctx.save()
  ctx.beginPath()
  ctx.moveTo(nl.x, nl.y)
  ctx.lineTo(nr.x, nr.y)
  ctx.lineTo(br.x, br.y)
  ctx.lineTo(bl.x, bl.y)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()
  ctx.restore()

  fillQuad(ctx, [fl, fr, nr, nl], '#222')
  const midDrop = 28 * fit
  const ul = { x: fl.x, y: fl.y + midDrop }
  const ur = { x: fr.x, y: fr.y + midDrop }
  const ml = extendToY(fl, nl, nl.y + midDrop * 0.35)
  const mr = extendToY(fr, nr, nr.y + midDrop * 0.35)
  fillQuad(ctx, [fl, fr, ur, ul], '#151515')
  fillQuad(ctx, [ul, ur, mr, ml], '#0c0c0c')
}

function drawFloorCell(
  ctx: CanvasRenderingContext2D,
  q: [Pt, Pt, Pt, Pt],
  fit: number,
  kind: 'floor' | 'entrance' | 'exit',
) {
  const line = Math.max(1.5, 2 * fit)
  if (kind === 'entrance') {
    fillQuad(ctx, q, ENTRANCE_FILL)
    strokeQuad(ctx, q, ENTRANCE_STROKE, line)
    return
  }
  if (kind === 'exit') {
    fillQuad(ctx, q, EXIT_FILL)
    strokeQuad(ctx, q, EXIT_STROKE, line)
    const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4
    const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4
    const inset = (p: Pt): Pt => ({
      x: cx + (p.x - cx) * 0.55,
      y: cy + (p.y - cy) * 0.55,
    })
    const inner: [Pt, Pt, Pt, Pt] = [inset(q[0]), inset(q[1]), inset(q[2]), inset(q[3])]
    fillQuad(ctx, inner, EXIT_MARK)
    strokeQuad(ctx, inner, EXIT_STROKE, Math.max(1, 1.2 * fit))
    return
  }
  fillQuad(ctx, q, FLOOR_FILL)
  strokeQuad(ctx, q, FLOOR_STROKE, line)
}

function crackHash(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

/** Jagged cracks along a floor edge that touches a Walls-perk pit. */
function drawCrackAlongEdge(
  ctx: CanvasRenderingContext2D,
  a: Pt,
  b: Pt,
  center: Pt,
  fit: number,
  seed: number,
) {
  const inset = (p: Pt, t: number): Pt => ({
    x: p.x + (center.x - p.x) * t,
    y: p.y + (center.y - p.y) * t,
  })
  const ia = inset(a, 0.06)
  const ib = inset(b, 0.06)

  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = 'rgba(32, 22, 14, 0.9)'
  ctx.lineWidth = Math.max(1.1, 1.35 * fit)

  // Primary fissure along the shared edge
  const segs = 6
  ctx.beginPath()
  for (let i = 0; i <= segs; i++) {
    const t = i / segs
    const along = { x: ia.x + (ib.x - ia.x) * t, y: ia.y + (ib.y - ia.y) * t }
    const pull = 0.02 + crackHash(seed + i * 4.1) * 0.1
    const px = along.x + (center.x - along.x) * pull
    const py = along.y + (center.y - along.y) * pull
    if (i === 0) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.stroke()

  // Short branches crawling onto the walkable cell
  ctx.lineWidth = Math.max(0.9, 1.05 * fit)
  ctx.strokeStyle = 'rgba(48, 34, 22, 0.78)'
  for (let bIdx = 0; bIdx < 3; bIdx++) {
    const t = 0.18 + crackHash(seed + 20 + bIdx * 9) * 0.64
    const root = {
      x: ia.x + (ib.x - ia.x) * t,
      y: ia.y + (ib.y - ia.y) * t,
    }
    const reach = 0.18 + crackHash(seed + 40 + bIdx * 7) * 0.22
    const tip = inset(root, reach)
    const midT = 0.45 + crackHash(seed + 55 + bIdx) * 0.2
    const mid = {
      x: root.x + (tip.x - root.x) * midT + (ib.x - ia.x) * (crackHash(seed + 70 + bIdx) - 0.5) * 0.12,
      y: root.y + (tip.y - root.y) * midT + (ib.y - ia.y) * (crackHash(seed + 80 + bIdx) - 0.5) * 0.12,
    }
    ctx.beginPath()
    ctx.moveTo(root.x + (center.x - root.x) * 0.04, root.y + (center.y - root.y) * 0.04)
    ctx.lineTo(mid.x, mid.y)
    ctx.lineTo(tip.x, tip.y)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * On walkable cells next to Walls-perk pits, crack the edges that touch those pits.
 */
function drawFloorPerkCracks(
  ctx: CanvasRenderingContext2D,
  q: [Pt, Pt, Pt, Pt],
  depth: number,
  lane: number,
  perkWalls: Set<string>,
  fit: number,
) {
  if (perkWalls.size === 0) return
  const tl = q[0]
  const tr = q[1]
  const br = q[2]
  const bl = q[3]
  const center = {
    x: (tl.x + tr.x + br.x + bl.x) / 4,
    y: (tl.y + tr.y + br.y + bl.y) / 4,
  }
  const edges: { a: Pt; b: Pt; adjKey: string; seed: number }[] = [
    { a: tl, b: tr, adjKey: cellKey(depth + 1, lane), seed: depth * 97 + lane * 13 + 1 },
    { a: bl, b: br, adjKey: cellKey(depth - 1, lane), seed: depth * 97 + lane * 13 + 2 },
    { a: tl, b: bl, adjKey: cellKey(depth, lane - 1), seed: depth * 97 + lane * 13 + 3 },
    { a: tr, b: br, adjKey: cellKey(depth, lane + 1), seed: depth * 97 + lane * 13 + 4 },
  ]
  for (const e of edges) {
    if (!perkWalls.has(e.adjKey)) continue
    drawCrackAlongEdge(ctx, e.a, e.b, center, fit, e.seed)
  }
}

function isFloorish(kind: TileKind | undefined): boolean {
  return kind === 'floor' || kind === 'entrance' || kind === 'exit'
}

type PitCliffVariant = 1 | 2 | 3 | 4 | 5

function pitDropParams(variant: PitCliffVariant) {
  const table: Record<
    PitCliffVariant,
    { rim: string; mid: string; midAt: number; band: number; decks: number; deckDark: string }
  > = {
    1: { rim: '#2e2e2e', mid: '#181818', midAt: 0.4, band: 0.32, decks: 2, deckDark: '#0c0c0c' },
    2: { rim: '#343434', mid: '#1a1a1a', midAt: 0.35, band: 0.4, decks: 2, deckDark: '#0a0a0a' },
    3: { rim: '#2a2a2a', mid: '#141414', midAt: 0.45, band: 0.28, decks: 1, deckDark: '#080808' },
    4: { rim: '#303030', mid: '#161616', midAt: 0.3, band: 0.48, decks: 3, deckDark: '#0b0b0b' },
    5: { rim: '#282828', mid: '#121212', midAt: 0.5, band: 0.36, decks: 2, deckDark: '#090909' },
  }
  return table[variant]
}

/** Floor-adjacent wall: fade-out drop down the rails (previous pit variants). */
function drawPlatformPitDrop(
  ctx: CanvasRenderingContext2D,
  q: [Pt, Pt, Pt, Pt],
  variant: PitCliffVariant,
  canvasH: number,
) {
  const tl = q[0]
  const tr = q[1]
  const br = q[2]
  const bl = q[3]
  const p = pitDropParams(variant)

  const botY = canvasH + 2
  const dropL = extendToY(tl, bl, botY)
  const dropR = extendToY(tr, br, botY)

  const grad = ctx.createLinearGradient(0, Math.min(tl.y, tr.y), 0, botY)
  grad.addColorStop(0, p.rim)
  grad.addColorStop(Math.max(0.05, Math.min(0.85, p.midAt)), p.mid)
  grad.addColorStop(1, '#050505')

  ctx.beginPath()
  ctx.moveTo(tl.x, tl.y)
  ctx.lineTo(tr.x, tr.y)
  ctx.lineTo(dropR.x, dropR.y)
  ctx.lineTo(dropL.x, dropL.y)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()

  const nearY = Math.max(bl.y, br.y)
  const midDrop = Math.max(10, (nearY - Math.min(tl.y, tr.y)) * p.band + (variant % 3) * 4)
  const ul = { x: tl.x, y: tl.y + midDrop * 0.45 }
  const ur = { x: tr.x, y: tr.y + midDrop * 0.45 }
  const ml = extendToY(tl, bl, Math.min(tl.y + midDrop, nearY + midDrop * 0.5))
  const mr = extendToY(tr, br, Math.min(tr.y + midDrop, nearY + midDrop * 0.5))

  fillQuad(ctx, [tl, tr, ur, ul], '#151515')
  fillQuad(ctx, [ul, ur, mr, ml], p.deckDark)

  if (p.decks >= 2) {
    const softTop = Math.max(ml.y, mr.y)
    const soft = ctx.createLinearGradient(0, softTop, 0, botY)
    soft.addColorStop(0, p.deckDark)
    soft.addColorStop(1, '#050505')
    ctx.beginPath()
    ctx.moveTo(ml.x, ml.y)
    ctx.lineTo(mr.x, mr.y)
    ctx.lineTo(dropR.x, dropR.y)
    ctx.lineTo(dropL.x, dropL.y)
    ctx.closePath()
    ctx.fillStyle = soft
    ctx.fill()
  }

  if (p.decks >= 3) {
    const band2 = midDrop * 1.15
    const u2l = extendToY(tl, bl, tl.y + band2)
    const u2r = extendToY(tr, br, tr.y + band2)
    fillQuad(ctx, [ml, mr, u2r, u2l], '#0a0a0a')
  }
}

function drawDashParticles(
  ctx: CanvasRenderingContext2D,
  cell: DashTrailCell,
  stand: Pt & { scale: number },
  ox: number,
  oy: number,
  fit: number,
) {
  if (cell.opacity <= 0.02) return
  const p = mapRefToCanvas(stand, ox, oy, fit)
  const cellW = ((REF.nearR - REF.nearL) / MAP_H) * stand.scale * fit
  const spread = cellW * 0.28
  const seed = (cell.x * 17 + cell.y * 31) | 0
  const count = 7
  for (let i = 0; i < count; i++) {
    const a = ((seed * 13 + i * 47) % 360) * (Math.PI / 180)
    const r = spread * (0.25 + ((seed + i * 9) % 10) / 14)
    const x = p.x + Math.cos(a) * r
    const y = p.y - cellW * 0.2 + Math.sin(a) * r * 0.7
    const rad = Math.max(1.5, cellW * (0.04 + (i % 3) * 0.015))
    ctx.save()
    ctx.globalAlpha = cell.opacity * (0.55 + (i % 4) * 0.1)
    ctx.fillStyle = i % 2 === 0 ? '#b44dff' : '#7a1fff'
    ctx.beginPath()
    ctx.arc(x, y, rad, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  // Soft glow under the cluster
  ctx.save()
  ctx.globalAlpha = cell.opacity * 0.35
  const g = ctx.createRadialGradient(p.x, p.y - cellW * 0.15, 0, p.x, p.y - cellW * 0.15, spread)
  g.addColorStop(0, 'rgba(180, 80, 255, 0.7)')
  g.addColorStop(1, 'rgba(120, 30, 255, 0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(p.x, p.y - cellW * 0.15, spread, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

/** Deterministic 0..1 hash for fog variation. */
function fogHash(a: number, b: number, c = 0): number {
  const n = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453
  return n - Math.floor(n)
}

/** Shrink a cell quad toward its center (stays inside the tile). */
function insetQuad(q: [Pt, Pt, Pt, Pt], t: number): [Pt, Pt, Pt, Pt] {
  const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4
  const cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4
  return q.map((p) => ({
    x: cx + (p.x - cx) * t,
    y: cy + (p.y - cy) * t,
  })) as [Pt, Pt, Pt, Pt]
}

function clipQuad(ctx: CanvasRenderingContext2D, q: [Pt, Pt, Pt, Pt]) {
  ctx.beginPath()
  ctx.moveTo(q[0].x, q[0].y)
  ctx.lineTo(q[1].x, q[1].y)
  ctx.lineTo(q[2].x, q[2].y)
  ctx.lineTo(q[3].x, q[3].y)
  ctx.closePath()
  ctx.clip()
}

/**
 * Fog clipped to a single cell. `density` 0..1 = farther from Friend → darker / more opaque.
 * Slow levitation stays inside the clip.
 */
function drawFogSubstance(
  ctx: CanvasRenderingContext2D,
  q: [Pt, Pt, Pt, Pt],
  depth: number,
  lane: number,
  timeMs: number,
  intensity: number,
  density: number,
  fit: number,
  alphaScale = 1,
) {
  const t = timeMs * 0.001
  const d = Math.max(0, Math.min(1, density))
  const hover = Math.sin(t * 0.55) * 2.2 * fit + Math.sin(t * 0.23 + 1.2) * 0.9 * fit
  const sway = Math.sin(t * 0.4 + depth * 0.15 + lane * 0.2) * 0.25 * fit
  const s = Math.max(0.05, Math.min(1, alphaScale))

  const hTone = fogHash(depth * 3, lane * 5)
  const a0 = (0.38 + d * 0.5 + intensity * 0.04) * s
  const a1 = (0.22 + d * 0.4 + intensity * 0.03) * s
  const a2 = (0.12 + d * 0.28) * s

  ctx.save()
  clipQuad(ctx, q)
  ctx.translate(sway, hover - 2.5 * fit)

  fillQuad(ctx, q, `rgba(0, 0, 0, ${a0})`)
  fillQuad(ctx, insetQuad(q, 0.92), `rgba(4, 6, 10, ${a1})`)

  const r = 8 + Math.floor(hTone * 10)
  const g = 10 + Math.floor(fogHash(depth, lane, 4) * 12)
  const b = 14 + Math.floor(fogHash(lane, depth, 5) * 14)
  fillQuad(
    ctx,
    insetQuad(q, 0.78 + fogHash(depth, lane, 1) * 0.12),
    `rgba(${r}, ${g}, ${b}, ${a1 * 0.85})`,
  )
  fillQuad(
    ctx,
    insetQuad(q, 0.55 + fogHash(lane, depth, 8) * 0.2),
    `rgba(0, 0, 0, ${a2})`,
  )

  ctx.restore()
}

function drawFogEyes(
  ctx: CanvasRenderingContext2D,
  depth: number,
  lane: number,
  opacity: number,
  ox: number,
  oy: number,
  fit: number,
  timeMs: number,
) {
  if (opacity <= 0.02) return
  const stand = cellCenter(depth, lane)
  const p = mapRefToCanvas(stand, ox, oy, fit)
  const cellW = ((REF.nearR - REF.nearL) / MAP_H) * stand.scale * fit
  const eyeR = Math.max(1.4, cellW * 0.045)
  const gap = cellW * 0.09
  const t = timeMs * 0.001
  const hover = Math.sin(t * 0.55) * 2.2 * fit + Math.sin(t * 0.23 + 1.2) * 0.9 * fit
  const bob = Math.sin(timeMs * 0.012 + depth + lane) * cellW * 0.02
  const y = p.y - cellW * 0.28 + bob + hover - 2.5 * fit

  ctx.save()
  ctx.globalAlpha = opacity
  for (const side of [-1, 1] as const) {
    const x = p.x + side * gap
    ctx.fillStyle = '#ff1a1a'
    ctx.beginPath()
    ctx.arc(x, y, eyeR, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(255, 80, 80, 0.35)'
    ctx.beginPath()
    ctx.arc(x, y, eyeR * 2.2, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Glowing red eyes for Horde-spawned (light-gray) mobs. */
function drawHordeEyes(
  ctx: CanvasRenderingContext2D,
  dx: number,
  dy: number,
  size: number,
) {
  drawDreadEyes(ctx, dx, dy, size, 1)
}

/** Red pulsing eyes for DreadfulBeasts mobs — intensity scales with rank. */
function drawDreadEyes(
  ctx: CanvasRenderingContext2D,
  dx: number,
  dy: number,
  size: number,
  rank: 1 | 2 | 3,
  timeMs = 0,
) {
  const cx = dx + size * 0.5
  const cy = dy + size * 0.34
  const gap = size * 0.11
  const baseEyeR = Math.max(1.2, size * 0.055)
  // Rank 2: pulse, rank 3: strong pulse
  const pulse =
    rank === 1 ? 1 : rank === 2 ? 0.9 + 0.1 * Math.sin(timeMs * 0.006) : 0.85 + 0.15 * Math.sin(timeMs * 0.009)
  const eyeR = baseEyeR * (rank === 1 ? 1 : rank === 2 ? 1.25 : 1.5) * pulse
  const glowR = eyeR * (rank === 1 ? 3.2 : rank === 2 ? 4.0 : 5.0)
  ctx.save()
  for (const side of [-1, 1] as const) {
    const x = cx + side * gap
    const glow = ctx.createRadialGradient(x, cy, eyeR * 0.2, x, cy, glowR)
    const innerAlpha = rank === 1 ? 0.95 : rank === 2 ? 1.0 : 1.0
    const midAlpha = rank === 1 ? 0.55 : rank === 2 ? 0.7 : 0.85
    glow.addColorStop(0, `rgba(255, 60, 60, ${innerAlpha})`)
    glow.addColorStop(0.35, `rgba(255, 20, 20, ${midAlpha})`)
    glow.addColorStop(1, 'rgba(180, 0, 0, 0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(x, cy, glowR, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#ff2a2a'
    ctx.beginPath()
    ctx.arc(x, cy, eyeR, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff0f0'
    ctx.beginPath()
    ctx.arc(x - eyeR * 0.25, cy - eyeR * 0.3, eyeR * 0.28, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

/** Soft blue ward around Friend while Endurance bonus STA is intact. */
function drawEnduranceShield(
  ctx: CanvasRenderingContext2D,
  center: Pt,
  cellW: number,
  timeMs: number,
) {
  const t = timeMs * 0.001
  const pulse = 0.85 + 0.15 * Math.sin(t * 3.2)
  const rx = cellW * 0.48 * pulse
  const ry = cellW * 0.58 * pulse
  const cx = center.x
  const cy = center.y - cellW * 0.22

  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(1, ry / rx)
  const g = ctx.createRadialGradient(0, 0, rx * 0.15, 0, 0, rx)
  g.addColorStop(0, 'rgba(120, 200, 255, 0.28)')
  g.addColorStop(0.55, 'rgba(60, 150, 255, 0.18)')
  g.addColorStop(1, 'rgba(40, 120, 255, 0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, rx, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = `rgba(140, 210, 255, ${0.55 + 0.2 * Math.sin(t * 4)})`
  ctx.lineWidth = Math.max(1.5, cellW * 0.04)
  ctx.beginPath()
  ctx.arc(0, 0, rx * 0.92, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

/** Shared outline opacity for Fearless (yellow) and Dreadful (red) by rank. */
const PERK_CONTOUR_ALPHA: Record<1 | 2 | 3, number> = {
  1: 0.4,
  2: 0.7,
  /** III: even silhouette, very weak */
  3: 0.2,
}

/**
 * Contour strip that follows the PNG silhouette (not a geometric circle).
 * Draws a colored expanded silhouette; call before the real sprite.
 */
function drawPngContour(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  size: number,
  rgb: [number, number, number],
  alpha: number,
  pad = 2,
) {
  if (alpha <= 0.01) return
  const sw = Math.max(1, Math.ceil(size) + pad * 2)
  const sh = Math.max(1, Math.ceil(size) + pad * 2)
  const off = document.createElement('canvas')
  off.width = sw
  off.height = sh
  const octx = off.getContext('2d')
  if (!octx) return

  octx.imageSmoothingEnabled = false
  octx.clearRect(0, 0, sw, sh)
  octx.drawImage(img, pad, pad, size, size)
  octx.globalCompositeOperation = 'source-in'
  octx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
  octx.fillRect(0, 0, sw, sh)

  ctx.save()
  ctx.imageSmoothingEnabled = false
  ctx.globalAlpha = alpha
  // Full neighborhood for an even strip around the silhouette
  for (let oy = -pad; oy <= pad; oy++) {
    for (let ox = -pad; ox <= pad; ox++) {
      if (ox === 0 && oy === 0) continue
      ctx.drawImage(off, dx - pad + ox, dy - pad + oy)
    }
  }
  ctx.restore()
}

type DreadSpark = {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  r: number
}

/** Trail left on the cell the mob just left. */
type DreadTrail = {
  mobX: number
  mobY: number
  cellX: number
  cellY: number
  bits: DreadSpark[]
}

/** Few tiny sparks that hop back onto the previous cell. */
function spawnHopBackSparks(cellW: number, n: number): DreadSpark[] {
  const out: DreadSpark[] = []
  for (let i = 0; i < n; i++) {
    const ang = Math.PI * 0.5 + (Math.random() - 0.5) * 1.2
    const spd = cellW * (0.004 + Math.random() * 0.008)
    out.push({
      x: (Math.random() - 0.5) * cellW * 0.12,
      y: (Math.random() - 0.5) * cellW * 0.1,
      vx: Math.cos(ang) * spd * (Math.random() < 0.5 ? -1 : 1) * 0.35,
      vy: Math.sin(ang) * spd,
      life: 0,
      maxLife: 260 + Math.random() * 220,
      r: Math.max(0.8, cellW * (0.012 + Math.random() * 0.012)),
    })
  }
  return out
}

function stepDreadTrail(trail: DreadTrail, dt: number): DreadTrail {
  const next: DreadSpark[] = []
  for (const b of trail.bits) {
    b.life += dt
    if (b.life >= b.maxLife) continue
    b.x += b.vx * (dt / 16)
    b.y += b.vy * (dt / 16)
    // Soft damp — stay near the previous cell
    b.vx *= 0.96
    b.vy *= 0.96
    next.push(b)
  }
  return { ...trail, bits: next }
}

function drawDreadSparks(
  ctx: CanvasRenderingContext2D,
  center: Pt,
  bits: DreadSpark[],
) {
  for (const b of bits) {
    const u = b.life / b.maxLife
    const a = u < 0.12 ? u / 0.12 : 1 - (u - 0.12) / 0.88
    ctx.save()
    ctx.globalAlpha = Math.max(0, a * 0.75)
    ctx.fillStyle = '#ff2a2a'
    ctx.beginPath()
    ctx.arc(center.x + b.x, center.y + b.y, b.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

type DodgePuff = {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  r: number
}

/** Purple duck particles — mostly downward. */
function spawnDodgePuffs(cellW: number, count: number): DodgePuff[] {
  const out: DodgePuff[] = []
  for (let i = 0; i < count; i++) {
    out.push({
      x: (Math.random() - 0.5) * cellW * 0.35,
      y: -cellW * (0.12 + Math.random() * 0.22),
      vx: (Math.random() - 0.5) * cellW * 0.008,
      vy: cellW * (0.022 + Math.random() * 0.03),
      life: 0,
      maxLife: 200 + Math.random() * 180,
      r: Math.max(1, cellW * (0.022 + Math.random() * 0.018)),
    })
  }
  return out
}

function stepDodgePuffs(bits: DodgePuff[], dt: number): DodgePuff[] {
  const next: DodgePuff[] = []
  for (const b of bits) {
    b.life += dt
    if (b.life >= b.maxLife) continue
    b.x += b.vx * (dt / 16)
    b.y += b.vy * (dt / 16)
    b.vy += 0.025 * (dt / 16)
    next.push(b)
  }
  return next
}

function drawDodgePuffs(ctx: CanvasRenderingContext2D, origin: Pt, bits: DodgePuff[]) {
  for (const b of bits) {
    const u = b.life / b.maxLife
    const a = u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85
    ctx.save()
    ctx.globalAlpha = Math.max(0, a * 0.8)
    ctx.fillStyle = ((Math.abs(b.x * 17 + b.y) * 10) | 0) % 2 === 0 ? '#b44dff' : '#7a1fff'
    ctx.beginPath()
    ctx.arc(origin.x + b.x, origin.y + b.y, b.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}

/** Dodge duck 0..1 → vertical scale (feet anchored). */
function dodgeSquashScale(u: number, rank: 1 | 2 | 3): number {
  if (u <= 0 || u >= 1) return 1
  const min = rank === 1 ? 0.58 : rank === 2 ? 0.42 : 0.26
  let t: number
  if (u < 0.35) t = u / 0.35
  else if (u < 0.5) t = 1
  else t = 1 - (u - 0.5) / 0.5
  const e = t * t * (3 - 2 * t)
  return 1 - (1 - min) * e
}

/**
 * Sharp Claws: three parallel slash marks across Friend's cell.
 * u 0..1 — each claw streaks in sequence then fades.
 */
function drawClawStrikes(
  ctx: CanvasRenderingContext2D,
  center: Pt,
  cellW: number,
  u: number,
  rank: 1 | 2 | 3,
) {
  if (u <= 0 || u >= 1) return
  const cx = center.x
  const cy = center.y - cellW * 0.2
  const len = cellW * (0.55 + rank * 0.06)
  const gap = cellW * 0.11
  const thick = Math.max(1.5, cellW * (0.035 + rank * 0.008))
  // Slash angle (top-left → bottom-right)
  const ang = -0.55
  const cos = Math.cos(ang)
  const sin = Math.sin(ang)

  for (let i = 0; i < 3; i++) {
    const start = i * 0.12
    const local = Math.max(0, Math.min(1, (u - start) / 0.35))
    if (local <= 0) continue
    const fade = local < 0.55 ? local / 0.55 : 1 - (local - 0.55) / 0.45
    const draw = Math.min(1, local / 0.45)
    const mid = (i - 1) * gap
    const ox = -sin * mid
    const oy = cos * mid
    const x0 = cx + ox - cos * len * 0.5
    const y0 = cy + oy - sin * len * 0.5
    const x1 = x0 + cos * len * draw
    const y1 = y0 + sin * len * draw

    ctx.save()
    ctx.globalAlpha = Math.max(0, fade * (0.55 + rank * 0.12))
    ctx.strokeStyle = '#e8e8f0'
    ctx.lineWidth = thick
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(255, 70, 90, 0.85)'
    ctx.lineWidth = thick * 0.45
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()
    ctx.restore()
  }
}

/** Brief light burst when Endurance bonus STA is depleted (u = 0..1). */
function drawEnduranceBreakFlash(
  ctx: CanvasRenderingContext2D,
  center: Pt,
  cellW: number,
  u: number,
) {
  if (u <= 0 || u >= 1) return
  const cx = center.x
  const cy = center.y - cellW * 0.22
  // Expand + fade
  const grow = 0.4 + u * 1.6
  const alpha = u < 0.25 ? u / 0.25 : 1 - (u - 0.25) / 0.75
  const rx = cellW * 0.55 * grow

  ctx.save()
  ctx.translate(cx, cy)
  ctx.globalAlpha = Math.max(0, alpha)
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx)
  g.addColorStop(0, 'rgba(255, 255, 255, 0.95)')
  g.addColorStop(0.35, 'rgba(180, 230, 255, 0.7)')
  g.addColorStop(0.7, 'rgba(100, 180, 255, 0.25)')
  g.addColorStop(1, 'rgba(80, 160, 255, 0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(0, 0, rx, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = `rgba(230, 250, 255, ${0.9 * alpha})`
  ctx.lineWidth = Math.max(2, cellW * 0.05 * (1 - u * 0.5))
  ctx.beginPath()
  ctx.arc(0, 0, rx * 0.85, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

type RallyConfettiBit = {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vr: number
  life: number
  maxLife: number
  w: number
  h: number
  color: string
}

function spawnRallyConfetti(cellW: number, seed: number): RallyConfettiBit[] {
  const colors = ['#b44dff', '#9b2fff', '#d280ff', '#7a1fff', '#e0b0ff', '#5c12c9']
  const bits: RallyConfettiBit[] = []
  const n = 18
  for (let i = 0; i < n; i++) {
    const a = ((seed * 17 + i * 47) % 360) * (Math.PI / 180)
    // Very tight scatter around Friend
    const speed = cellW * (0.005 + ((seed + i * 13) % 10) / 500)
    const px = 3 + (i % 2) // 3–4px chips
    bits.push({
      x: Math.sin(a * 3 + i) * cellW * 0.02,
      y: -cellW * 0.08 + Math.cos(a * 2) * cellW * 0.015,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed * 0.55 - cellW * 0.003,
      rot: a,
      vr: ((i % 5) - 2) * 0.08,
      life: 0,
      maxLife: 420 + (i % 7) * 25,
      w: px,
      h: Math.max(2, px - 1),
      color: colors[i % colors.length]!,
    })
  }
  return bits
}

function drawRallyConfetti(
  ctx: CanvasRenderingContext2D,
  center: Pt,
  bits: RallyConfettiBit[],
) {
  for (const b of bits) {
    const u = b.life / b.maxLife
    if (u >= 1) continue
    const alpha = u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85
    ctx.save()
    ctx.translate(center.x + b.x, center.y + b.y)
    ctx.rotate(b.rot)
    ctx.globalAlpha = Math.max(0, alpha)
    ctx.fillStyle = b.color
    ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h)
    ctx.restore()
  }
}

/** Square purple flag with white RF — planted at cell center (visual only). */
function drawRallyFlagAt(
  ctx: CanvasRenderingContext2D,
  baseX: number,
  baseY: number,
  cellW: number,
) {
  const poleH = cellW * 0.52
  const flagSize = cellW * 0.28

  ctx.save()
  // Pole
  ctx.strokeStyle = '#3a2a4a'
  ctx.lineWidth = Math.max(1.5, cellW * 0.035)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(baseX, baseY)
  ctx.lineTo(baseX, baseY - poleH)
  ctx.stroke()
  // Square pennant
  const top = baseY - poleH
  ctx.fillStyle = '#9b2fff'
  ctx.fillRect(baseX, top, flagSize, flagSize)
  ctx.strokeStyle = 'rgba(224, 176, 255, 0.85)'
  ctx.lineWidth = 1
  ctx.strokeRect(baseX, top, flagSize, flagSize)
  // White RF
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${Math.max(8, flagSize * 0.48)}px sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('RF', baseX + flagSize / 2, top + flagSize / 2 + 0.5)
  // Ground pin
  ctx.fillStyle = 'rgba(80, 40, 120, 0.55)'
  ctx.beginPath()
  ctx.ellipse(baseX, baseY + 1, cellW * 0.08, cellW * 0.03, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function drawRallyFlag(
  ctx: CanvasRenderingContext2D,
  depth: number,
  lane: number,
  ox: number,
  oy: number,
  fit: number,
) {
  const stand = cellCenter(depth, lane)
  const p = mapRefToCanvas(stand, ox, oy, fit)
  const cellW = ((REF.nearR - REF.nearL) / MAP_H) * stand.scale * fit
  // Center of cell
  drawRallyFlagAt(ctx, p.x, p.y, cellW)
}

/**
 * Darken the whole board (cells + front apron) by distance from Friend:
 * near FOV stays readable, far / behind / apron fall into shadow.
 */
function drawVisionFalloff(
  ctx: CanvasRenderingContext2D,
  friendScreen: Pt,
  visionScreenR: number,
  width: number,
  height: number,
) {
  const inner = Math.max(8, visionScreenR * 0.28)
  const mid = Math.max(inner + 1, visionScreenR * 0.92)
  const outer = Math.max(mid + 1, Math.hypot(width, height) * 1.15)

  const g = ctx.createRadialGradient(
    friendScreen.x,
    friendScreen.y,
    inner,
    friendScreen.x,
    friendScreen.y,
    outer,
  )
  g.addColorStop(0, 'rgba(0, 0, 0, 0)')
  g.addColorStop(Math.min(0.42, mid / outer), 'rgba(0, 0, 0, 0.12)')
  g.addColorStop(Math.min(0.62, (mid * 1.15) / outer), 'rgba(0, 0, 0, 0.42)')
  g.addColorStop(0.82, 'rgba(0, 0, 0, 0.72)')
  g.addColorStop(1, 'rgba(0, 0, 0, 0.9)')

  ctx.save()
  ctx.fillStyle = g
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

/**
 * Front apron sits just before depth 0. When it leaves Friend vision → solid black.
 * 0 = fully lit (in vision), 1 = fully black (outside vision).
 */
function apronOutOfVisionDarkness(friendDepth: number, vision: number): number {
  const apronDist = friendDepth + 1
  if (apronDist <= vision) return 0
  return Math.min(1, (apronDist - vision) / 1)
}

/** Fill the canonical front-apron polygon (near edge → canvas bottom). */
function fillFrontApron(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  fit: number,
  canvasH: number,
  style: string | CanvasGradient,
) {
  const near = rowEdge(0)
  const far = rowEdge(1)
  const fl = mapRefToCanvas({ x: far.left, y: far.y }, ox, oy, fit)
  const fr = mapRefToCanvas({ x: far.right, y: far.y }, ox, oy, fit)
  const nl = mapRefToCanvas({ x: near.left, y: near.y }, ox, oy, fit)
  const nr = mapRefToCanvas({ x: near.right, y: near.y }, ox, oy, fit)
  const botY = canvasH + 2
  const bl = extendToY(fl, nl, botY)
  const br = extendToY(fr, nr, botY)

  ctx.beginPath()
  ctx.moveTo(nl.x, nl.y)
  ctx.lineTo(nr.x, nr.y)
  ctx.lineTo(br.x, br.y)
  ctx.lineTo(bl.x, bl.y)
  ctx.closePath()
  ctx.fillStyle = style
  ctx.fill()
}

export function DungeonCanvas({
  raid,
  highlights = [],
  jumpAnim = null,
  friendHurt = false,
  hurtMobId = null,
  dashTrail = [],
  enduranceShield = false,
  enduranceBreakT = 0,
  rallyBurstId = 0,
  rallyFlags = [],
  dodgeBurstId = 0,
  clawsBurstId = 0,
  boardOpacity = 1,
  pitCliffStyle = 4,
  revealAll = false,
  liteFogPreview = false,
  width = 980,
  height = 560,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(0)
  const [fogTick, setFogTick] = useState(0)
  const [idleTick, setIdleTick] = useState(0)
  const [enduranceAnimTick, setEnduranceAnimTick] = useState(0)
  const [rallyAnimTick, setRallyAnimTick] = useState(0)
  const [auraAnimTick, setAuraAnimTick] = useState(0)
  const [dodgeAnimTick, setDodgeAnimTick] = useState(0)
  const [clawsAnimTick, setClawsAnimTick] = useState(0)
  const friendImg = useRef<HTMLImageElement | null>(null)
  const mobImg = useRef<HTMLImageElement | null>(null)
  const fogEyesRef = useRef<FogEyePair | null>(null)
  /** After eyes vanish, wait until this time before spawning elsewhere. */
  const fogEyeCooldownRef = useRef(0)
  const fogTimeRef = useRef(0)
  const rallyBitsRef = useRef<RallyConfettiBit[]>([])
  const rallyBurstSeenRef = useRef(0)
  const rallyNeedsSpawnRef = useRef(false)
  const dreadSparksRef = useRef<Map<number, DreadTrail>>(new Map())
  const dodgePuffsRef = useRef<DodgePuff[]>([])
  const dodgeAnimURef = useRef(0)
  const dodgeBurstSeenRef = useRef(0)
  const dodgeFrameRef = useRef(performance.now())
  const clawsAnimURef = useRef(0)
  const clawsBurstSeenRef = useRef(0)
  const clawsFrameRef = useRef(performance.now())
  const lastFrameRef = useRef(performance.now())
  const auraFrameRef = useRef(performance.now())
  const raidRef = useRef(raid)
  raidRef.current = raid

  useEffect(() => {
    const bump = () => setReady((n) => n + 1)
    const load = (src: string, slot: { current: HTMLImageElement | null }) => {
      const img = new Image()
      img.onload = bump
      img.onerror = bump
      img.src = src
      slot.current = img
    }
    load('/sprites/friend.png', friendImg)
    load('/sprites/mob.png', mobImg)
  }, [])

  // Pulse Endurance ward / break flash between raid ticks
  useEffect(() => {
    if (!enduranceShield && enduranceBreakT <= 0) return
    let raf = 0
    const tick = () => {
      setEnduranceAnimTick((n) => n + 1)
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [enduranceShield, enduranceBreakT])

  // Fearless / Dreadful aura pulse (+ Dread III trail sparks on previous cell)
  useEffect(() => {
    const fear = raid.perkMods.fearlessRank
    const dread = raid.perkMods.dreadRank
    if (!fear && !dread) {
      dreadSparksRef.current.clear()
      return
    }
    auraFrameRef.current = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const dt = Math.min(48, now - auraFrameRef.current)
      auraFrameRef.current = now
      const live = raidRef.current
      if (dread === 3) {
        const living = new Set(live.mobs.filter((m) => m.hp > 0).map((m) => m.id))
        const map = dreadSparksRef.current
        for (const id of [...map.keys()]) {
          if (!living.has(id)) map.delete(id)
        }
        const cellW = 28
        for (const m of live.mobs) {
          if (m.hp <= 0) continue
          let trail = map.get(m.id)
          if (!trail) {
            trail = { mobX: m.x, mobY: m.y, cellX: m.x, cellY: m.y, bits: [] }
          } else if (m.x !== trail.mobX || m.y !== trail.mobY) {
            // Leave a short hop-back puff on the cell just vacated
            trail = {
              mobX: m.x,
              mobY: m.y,
              cellX: trail.mobX,
              cellY: trail.mobY,
              bits: [
                ...trail.bits.slice(-2),
                ...spawnHopBackSparks(cellW, 2 + (Math.random() < 0.35 ? 1 : 0)),
              ].slice(-5),
            }
          }
          map.set(m.id, stepDreadTrail(trail, dt))
        }
      } else {
        dreadSparksRef.current.clear()
      }
      setAuraAnimTick((n) => n + 1)
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [raid.perkMods.fearlessRank, raid.perkMods.dreadRank])

  // Rally purple confetti burst
  useEffect(() => {
    if (rallyBurstId <= 0 || rallyBurstId === rallyBurstSeenRef.current) return
    rallyBurstSeenRef.current = rallyBurstId
    rallyNeedsSpawnRef.current = true
    lastFrameRef.current = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const dt = Math.min(48, now - lastFrameRef.current)
      lastFrameRef.current = now
      const bits = rallyBitsRef.current
      let alive = false
      for (const b of bits) {
        b.life += dt
        if (b.life < b.maxLife) {
          alive = true
          b.x += b.vx * (dt / 16)
          b.y += b.vy * (dt / 16)
          b.vy += 0.04 * (dt / 16)
          b.rot += b.vr * (dt / 16)
        }
      }
      setRallyAnimTick((n) => n + 1)
      if (alive || rallyNeedsSpawnRef.current) raf = window.requestAnimationFrame(tick)
      else rallyBitsRef.current = []
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [rallyBurstId])

  // Dodge duck squash + downward purple puffs (II/III)
  useEffect(() => {
    if (dodgeBurstId <= 0 || dodgeBurstId === dodgeBurstSeenRef.current) return
    dodgeBurstSeenRef.current = dodgeBurstId
    dodgeAnimURef.current = 0
    dodgeFrameRef.current = performance.now()
    const rank = raidRef.current.perkMods.dodgeRank
    const cellWApprox = 36
    if (rank >= 2) {
      dodgePuffsRef.current = spawnDodgePuffs(cellWApprox, rank === 3 ? 10 : 5)
    } else {
      dodgePuffsRef.current = []
    }
    const DUR = 320
    let raf = 0
    const tick = (now: number) => {
      const dt = Math.min(48, now - dodgeFrameRef.current)
      dodgeFrameRef.current = now
      dodgeAnimURef.current = Math.min(1, dodgeAnimURef.current + dt / DUR)
      dodgePuffsRef.current = stepDodgePuffs(dodgePuffsRef.current, dt)
      setDodgeAnimTick((n) => n + 1)
      if (dodgeAnimURef.current < 1 || dodgePuffsRef.current.length) {
        raf = window.requestAnimationFrame(tick)
      } else {
        dodgeAnimURef.current = 0
        dodgePuffsRef.current = []
      }
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [dodgeBurstId])

  // Sharp Claws: three slash marks on Friend's cell
  useEffect(() => {
    if (clawsBurstId <= 0 || clawsBurstId === clawsBurstSeenRef.current) return
    clawsBurstSeenRef.current = clawsBurstId
    clawsAnimURef.current = 0
    clawsFrameRef.current = performance.now()
    const DUR = 380
    let raf = 0
    const tick = (now: number) => {
      const dt = Math.min(48, now - clawsFrameRef.current)
      clawsFrameRef.current = now
      clawsAnimURef.current = Math.min(1, clawsAnimURef.current + dt / DUR)
      setClawsAnimTick((n) => n + 1)
      if (clawsAnimURef.current < 1) raf = window.requestAnimationFrame(tick)
      else clawsAnimURef.current = 0
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [clawsBurstId])

  // Slow idle hop for standing mobs (background bob)
  useEffect(() => {
    let raf = 0
    let last = 0
    const tick = (now: number) => {
      if (now - last >= 80) {
        last = now
        setIdleTick((n) => n + 1)
      }
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [])

  // Fog perk: soft veil + one eye pair (prefer hidden mobs, else random)
  useEffect(() => {
    const fogOn = raid.perkMods.fogPenalty > 0
    const runFog = fogOn && (!revealAll || liteFogPreview)
    if (!runFog) {
      fogEyesRef.current = null
      fogEyeCooldownRef.current = 0
      return
    }
    let raf = 0
    const tick = (now: number) => {
      fogTimeRef.current = now

      const friend = raidRef.current.friend
      const mobs = raidRef.current.mobs
      const fogCells: Cell[] = []
      for (let depth = 0; depth < MAP_W; depth++) {
        for (let lane = 0; lane < MAP_H; lane++) {
          if (!isCurrentlyVisible(friend, depth, lane)) {
            fogCells.push({ x: depth, y: lane })
          }
        }
      }

      const fogMobs = mobs.filter(
        (m) => m.hp > 0 && !isCurrentlyVisible(friend, m.x, m.y),
      )

      let eye = fogEyesRef.current
      if (eye) {
        if (eye.mobId != null) {
          const mob = mobs.find((m) => m.id === eye!.mobId && m.hp > 0)
          if (!mob || isCurrentlyVisible(friend, mob.x, mob.y)) {
            fogEyesRef.current = null
            fogEyeCooldownRef.current = now + 2500 + Math.random() * 1500
            eye = null
          } else {
            eye = { ...eye, x: mob.x, y: mob.y }
            fogEyesRef.current = eye
          }
        }

        if (eye) {
          const expired = now - eye.born >= eye.life
          const covered = isCurrentlyVisible(friend, eye.x, eye.y)
          if (expired || covered) {
            fogEyesRef.current = null
            fogEyeCooldownRef.current = now + 2500 + Math.random() * 1500
            eye = null
          }
        }
      }

      if (!eye && fogCells.length && now >= fogEyeCooldownRef.current) {
        if (fogMobs.length) {
          const mob = fogMobs[Math.floor(Math.random() * fogMobs.length)]!
          fogEyesRef.current = {
            x: mob.x,
            y: mob.y,
            born: now,
            life: 1000 + Math.random() * 200,
            mobId: mob.id,
          }
        } else {
          const pick = fogCells[Math.floor(Math.random() * fogCells.length)]!
          fogEyesRef.current = {
            x: pick.x,
            y: pick.y,
            born: now,
            life: 1000 + Math.random() * 200,
          }
        }
        fogEyeCooldownRef.current = Number.POSITIVE_INFINITY
      }

      setFogTick((n) => n + 1)
      raf = window.requestAnimationFrame(tick)
    }
    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [
    revealAll,
    liteFogPreview,
    raid.perkMods.fogPenalty,
    raid.friend.x,
    raid.friend.y,
    raid.friend.vision,
    raid.mobs,
    raid.dungeonId,
    raid.floor,
  ])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, width, height)

    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, boardOpacity))

    const { fit, ox, oy } = fitRefCamera(width, height)

    const toCanvasQuad = (depth: number, lane: number): [Pt, Pt, Pt, Pt] =>
      mapQuad(cellQuad(depth, lane), ox, oy, fit)

    drawPlatform(ctx, ox, oy, fit, height)

    const seeAll = revealAll || liteFogPreview
    const fogAlphaScale = liteFogPreview ? 0.4 : 1

    type PitDrop = { q: [Pt, Pt, Pt, Pt]; visible: boolean }
    const pitDrops: PitDrop[] = []
    const wallsPerkSet = new Set(raid.wallsPerkCells)

    for (let depth = MAP_W - 1; depth >= 0; depth--) {
      for (let lane = 0; lane < MAP_H; lane++) {
        const key = cellKey(depth, lane)
        const revealed = seeAll || raid.knowledge.revealed.has(key)
        const visible = seeAll || isCurrentlyVisible(raid.friend, depth, lane)
        const q = toCanvasQuad(depth, lane)
        const kind = tileAt(raid.map.tiles, depth, lane)

        if (!revealed) {
          fillQuad(ctx, q, 'rgba(0,0,0,0.72)')
          continue
        }

        if (kind === 'wall') {
          const farKind =
            depth + 1 < MAP_W ? tileAt(raid.map.tiles, depth + 1, lane) : undefined
          const floorFar = isFloorish(farKind)
          if (floorFar) pitDrops.push({ q, visible })
          else fillQuad(ctx, q, '#000000')
          continue
        }

        if (kind === 'entrance') drawFloorCell(ctx, q, fit, 'entrance')
        else if (kind === 'exit') drawFloorCell(ctx, q, fit, 'exit')
        else drawFloorCell(ctx, q, fit, 'floor')
        drawFloorPerkCracks(ctx, q, depth, lane, wallsPerkSet, fit)
        // Lite create fog: skip memory dim — fog veil carries the look
        if (!visible && !liteFogPreview) fillQuad(ctx, q, 'rgba(0,0,0,0.28)')
      }
    }

    for (const drop of pitDrops) {
      drawPlatformPitDrop(ctx, drop.q, pitCliffStyle as PitCliffVariant, height)
      if (!drop.visible && !liteFogPreview) fillQuad(ctx, drop.q, 'rgba(0,0,0,0.28)')
    }

    // Restore high-platform apron after pit spill (do not alter apron geometry)
    drawPlatform(ctx, ox, oy, fit, height)

    for (let depth = MAP_W - 1; depth >= 0; depth--) {
      for (let lane = 0; lane < MAP_H; lane++) {
        const key = cellKey(depth, lane)
        const revealed = seeAll || raid.knowledge.revealed.has(key)
        if (!revealed) {
          fillQuad(ctx, toCanvasQuad(depth, lane), 'rgba(0,0,0,0.72)')
          continue
        }
        const kind = tileAt(raid.map.tiles, depth, lane)
        if (!isFloorish(kind)) continue
        const visible = seeAll || isCurrentlyVisible(raid.friend, depth, lane)
        const q = toCanvasQuad(depth, lane)
        if (kind === 'entrance') drawFloorCell(ctx, q, fit, 'entrance')
        else if (kind === 'exit') drawFloorCell(ctx, q, fit, 'exit')
        else drawFloorCell(ctx, q, fit, 'floor')
        drawFloorPerkCracks(ctx, q, depth, lane, wallsPerkSet, fit)
        if (!visible && !liteFogPreview) fillQuad(ctx, q, 'rgba(0,0,0,0.28)')
      }
    }

    // Sharp Eye: green contours beyond base vision (farther ring = stronger)
    if (!seeAll && raid.perkMods.visionBonus > 0) {
      for (let depth = 0; depth < MAP_W; depth++) {
        for (let lane = 0; lane < MAP_H; lane++) {
          const ring = sharpEyeRing(raid.friend, raid.perkMods, depth, lane)
          if (!ring) continue
          if (!raid.knowledge.revealed.has(cellKey(depth, lane))) continue
          if (!isCurrentlyVisible(raid.friend, depth, lane)) continue
          fillQuad(ctx, toCanvasQuad(depth, lane), SHARP_EYE_GLOW[ring])
        }
      }
    }

    for (const h of highlights) {
      if (h.x < 0 || h.y < 0 || h.x >= MAP_W || h.y >= MAP_H) continue
      const q = toCanvasQuad(h.x, h.y)
      fillQuad(ctx, q, 'rgba(255,255,255,0.4)')
      strokeQuad(ctx, q, 'rgba(255,255,255,1)', Math.max(2, 2.5 * fit))
    }

    for (const trail of dashTrail) {
      if (trail.x < 0 || trail.y < 0 || trail.x >= MAP_W || trail.y >= MAP_H) continue
      drawDashParticles(ctx, trail, cellCenter(trail.x, trail.y), ox, oy, fit)
    }

    const animT = jumpAnim ? easeJump(Math.max(0, Math.min(1, jumpAnim.t))) : 0
    const hop = jumpAnim ? Math.sin(Math.PI * jumpAnim.t) * 10 * fit : 0

    type ActorDraw = {
      kind: 'mob' | 'friend'
      depth: number
      lane: number
      screen?: Pt
      mobId?: number
    }
    const actors: ActorDraw[] = []

    if (jumpAnim) {
      const ff = cellCenter(jumpAnim.friendFrom.x, jumpAnim.friendFrom.y)
      const ft = cellCenter(jumpAnim.friendTo.x, jumpAnim.friendTo.y)
      const fp = mapRefToCanvas(
        { x: lerp(ff.x, ft.x, animT), y: lerp(ff.y, ft.y, animT) },
        ox,
        oy,
        fit,
      )
      actors.push({
        kind: 'friend',
        depth: jumpAnim.friendTo.x,
        lane: jumpAnim.friendTo.y,
        screen: { x: fp.x, y: fp.y - hop },
      })
      const animatedIds = new Set<number>()
      for (const m of jumpAnim.mobs) {
        const live = raid.mobs.find((x) => x.id === m.id && x.hp > 0)
        if (!live) continue
        animatedIds.add(m.id)
        const keyTo = cellKey(m.to.x, m.to.y)
        const keyFrom = cellKey(m.from.x, m.from.y)
        const seeFrom =
          isCurrentlyVisible(raid.friend, m.from.x, m.from.y) ||
          raid.knowledge.revealed.has(keyFrom)
        const seeTo =
          isCurrentlyVisible(raid.friend, m.to.x, m.to.y) ||
          raid.knowledge.revealed.has(keyTo)
        if (!seeFrom && !seeTo) continue
        const stay = m.from.x === m.to.x && m.from.y === m.to.y
        const mf = cellCenter(m.from.x, m.from.y)
        const mt = cellCenter(m.to.x, m.to.y)
        const mp = mapRefToCanvas(
          { x: lerp(mf.x, mt.x, animT), y: lerp(mf.y, mt.y, animT) },
          ox,
          oy,
          fit,
        )
        const mobHop = hop * (stay ? 1 : 0.85)
        actors.push({
          kind: 'mob',
          mobId: m.id,
          depth: m.to.x,
          lane: m.to.y,
          screen: { x: mp.x, y: mp.y - mobHop },
        })
      }
      for (const mob of raid.mobs) {
        if (mob.hp <= 0 || animatedIds.has(mob.id)) continue
        const key = cellKey(mob.x, mob.y)
        if (!seeAll && !raid.knowledge.revealed.has(key)) continue
        const c = cellCenter(mob.x, mob.y)
        const p = mapRefToCanvas(c, ox, oy, fit)
        actors.push({
          kind: 'mob',
          mobId: mob.id,
          depth: mob.x,
          lane: mob.y,
          screen: { x: p.x, y: p.y - hop * 0.5 },
        })
      }
    } else {
      for (const mob of raid.mobs) {
        if (mob.hp <= 0) continue
        if (seeAll) {
          actors.push({ kind: 'mob', mobId: mob.id, depth: mob.x, lane: mob.y })
          continue
        }
        const key = cellKey(mob.x, mob.y)
        const visible = isCurrentlyVisible(raid.friend, mob.x, mob.y)
        const remembered = raid.knowledge.mobs.get(mob.id) === key
        if (!raid.knowledge.revealed.has(key)) continue
        if (!visible) {
          // Fog veil replaces remembered silhouettes with fake eyes
          if (raid.perkMods.fogPenalty > 0 || !remembered) continue
        }
        actors.push({ kind: 'mob', mobId: mob.id, depth: mob.x, lane: mob.y })
      }
      actors.push({ kind: 'friend', depth: raid.friend.x, lane: raid.friend.y })
    }

    actors.sort((a, b) => b.depth - a.depth || a.lane - b.lane)

    const drawTinted = (
      img: HTMLImageElement,
      dx: number,
      dy: number,
      size: number,
      hordeLook = false,
    ) => {
      const sw = Math.max(1, Math.ceil(size))
      const sh = Math.max(1, Math.ceil(size))
      const off = document.createElement('canvas')
      off.width = sw
      off.height = sh
      const octx = off.getContext('2d')
      if (!octx) {
        ctx.drawImage(img, dx, dy, size, size)
        return
      }
      octx.imageSmoothingEnabled = false
      octx.clearRect(0, 0, sw, sh)
      if (hordeLook) octx.filter = 'grayscale(100%) brightness(1.55) contrast(0.92)'
      octx.drawImage(img, 0, 0, size, size)
      octx.filter = 'none'
      octx.globalCompositeOperation = 'source-atop'
      octx.fillStyle = '#ff1a1a'
      octx.globalAlpha = 0.82
      octx.fillRect(0, 0, sw, sh)
      octx.globalAlpha = 1
      ctx.drawImage(off, dx, dy)
      // Horde tint: no eyes (contour drawn separately before sprite)
    }

    const drawHordeMob = (img: HTMLImageElement, dx: number, dy: number, size: number) => {
      const sw = Math.max(1, Math.ceil(size))
      const sh = Math.max(1, Math.ceil(size))
      const off = document.createElement('canvas')
      off.width = sw
      off.height = sh
      const octx = off.getContext('2d')
      if (!octx) {
        ctx.drawImage(img, dx, dy, size, size)
        return
      }
      octx.imageSmoothingEnabled = false
      octx.clearRect(0, 0, sw, sh)
      // Light-gray body (not full black)
      octx.filter = 'grayscale(100%) brightness(1.55) contrast(0.92)'
      octx.drawImage(img, 0, 0, size, size)
      octx.filter = 'none'
      ctx.drawImage(off, dx, dy)
      // Horde mob: no eyes (contour drawn separately)
    }

    for (const a of actors) {
      const img = a.kind === 'friend' ? friendImg.current : mobImg.current
      if (!img?.complete || img.naturalWidth < 1) continue

      const stand = cellCenter(a.depth, a.lane)
      const cellW = ((REF.nearR - REF.nearL) / MAP_H) * stand.scale * fit
      const size = cellW * 0.85
      const p = a.screen ?? mapRefToCanvas(stand, ox, oy, fit)
      const now = performance.now()
      const fromHorde =
        a.kind === 'mob' && a.mobId != null
          ? !!raid.mobs.find((m) => m.id === a.mobId)?.fromHorde
          : false

      if (a.kind === 'friend') {
        if (enduranceShield) drawEnduranceShield(ctx, p, cellW, now)
        if (enduranceBreakT > 0) drawEnduranceBreakFlash(ctx, p, cellW, enduranceBreakT)
        if (rallyNeedsSpawnRef.current || rallyBitsRef.current.length) {
          if (rallyNeedsSpawnRef.current) {
            rallyBitsRef.current = spawnRallyConfetti(cellW, rallyBurstId * 9973)
            rallyNeedsSpawnRef.current = false
          }
          drawRallyConfetti(ctx, { x: p.x, y: p.y - cellW * 0.15 }, rallyBitsRef.current)
        }
      }

      ctx.imageSmoothingEnabled = false
      const hideRank = raid.perkMods.hideRank
      const hideScale =
        a.kind === 'mob' && (hideRank === 1 || hideRank === 2 || hideRank === 3)
          ? 1 + hideRank * 0.1
          : 1
      const drawSize = size * hideScale
      const idleBob =
        a.kind === 'mob' && !a.screen
          ? Math.sin(now * 0.0022 + a.depth * 0.85 + a.lane * 1.3) * (2.8 * fit)
          : 0
      const dx = p.x - drawSize / 2
      // Keep feet on the cell: expand upward when Thick Hide scales the sprite
      const dy = p.y - size * 0.72 - (drawSize - size) - idleBob

      const dodgeRank = raid.perkMods.dodgeRank
      const dodgeU = a.kind === 'friend' ? dodgeAnimURef.current : 0
      const squash =
        a.kind === 'friend' &&
        (dodgeRank === 1 || dodgeRank === 2 || dodgeRank === 3) &&
        dodgeU > 0 &&
        dodgeU < 1
          ? dodgeSquashScale(dodgeU, dodgeRank)
          : 1

      const drawActorSprite = () => {
        // Silhouette contour (same alpha per rank for yellow & red), then sprite on top
        if (a.kind === 'friend') {
          const fearRank = raid.perkMods.fearlessRank
          if (fearRank === 1 || fearRank === 2 || fearRank === 3) {
            const pad =
              fearRank === 3
                ? Math.max(2, Math.round(drawSize * 0.035))
                : Math.max(2, Math.round(drawSize * 0.045))
            drawPngContour(
              ctx,
              img,
              dx,
              dy,
              drawSize,
              [255, 220, 70],
              PERK_CONTOUR_ALPHA[fearRank],
              pad,
            )
          }
        } else if (a.kind === 'mob' && a.mobId != null) {
          // DreadfulBeasts: red contour removed — eyes only (drawn after sprite below)
        }

        const tint =
          (a.kind === 'friend' && friendHurt) ||
          (a.kind === 'mob' && hurtMobId != null && a.mobId === hurtMobId)

        // Horde: red contour around PNG (no eyes)
        if (a.kind === 'mob' && fromHorde) {
          const hordePad = Math.max(2, Math.round(drawSize * 0.045))
          drawPngContour(ctx, img, dx, dy, drawSize, [255, 40, 40], 0.32, hordePad)
        }

        if (tint) drawTinted(img, dx, dy, drawSize, fromHorde)
        else if (fromHorde) drawHordeMob(img, dx, dy, drawSize)
        else ctx.drawImage(img, dx, dy, drawSize, drawSize)
      }

      if (squash < 0.999) {
        // Duck: squash toward the floor (feet pivot)
        ctx.save()
        ctx.translate(dx + drawSize / 2, dy + drawSize)
        ctx.scale(1, squash)
        ctx.translate(-(dx + drawSize / 2), -(dy + drawSize))
        drawActorSprite()
        ctx.restore()
      } else {
        drawActorSprite()
      }

      if (a.kind === 'friend' && dodgePuffsRef.current.length) {
        drawDodgePuffs(ctx, { x: p.x, y: dy + drawSize * 0.15 * squash }, dodgePuffsRef.current)
      }

      if (a.kind === 'friend' && clawsAnimURef.current > 0 && clawsAnimURef.current < 1) {
        const cr = raid.perkMods.clawsRank
        if (cr === 1 || cr === 2 || cr === 3) {
          drawClawStrikes(ctx, p, cellW, clawsAnimURef.current, cr)
        }
      }

      // DreadfulBeasts: red eyes drawn on top of sprite (all mobs when dread active)
      if (a.kind === 'mob') {
        const dreadRank = raid.perkMods.dreadRank
        if (dreadRank === 1 || dreadRank === 2 || dreadRank === 3) {
          drawDreadEyes(ctx, dx, dy, drawSize, dreadRank, now)
        }
      }
    }

    // Dread III: tiny red sparks on vacated cell — never through FOW / fog
    if (raid.perkMods.dreadRank === 3) {
      for (const [, trail] of dreadSparksRef.current) {
        if (!trail.bits.length) continue
        if (trail.cellX === trail.mobX && trail.cellY === trail.mobY) continue
        if (
          !revealAll &&
          (!raid.knowledge.revealed.has(cellKey(trail.cellX, trail.cellY)) ||
            !isCurrentlyVisible(raid.friend, trail.cellX, trail.cellY))
        ) {
          continue
        }
        const stand = cellCenter(trail.cellX, trail.cellY)
        const cellW = ((REF.nearR - REF.nearL) / MAP_H) * stand.scale * fit
        const p = mapRefToCanvas(stand, ox, oy, fit)
        drawDreadSparks(ctx, { x: p.x, y: p.y - cellW * 0.1 }, trail.bits)
      }
    }

    // Rally flags under fog / vision falloff (hidden when shrouded)
    for (const flag of rallyFlags) {
      if (flag.x < 0 || flag.y < 0 || flag.x >= MAP_W || flag.y >= MAP_H) continue
      drawRallyFlag(ctx, flag.x, flag.y, ox, oy, fit)
    }

    // Vision falloff + apron blackout — only while Fog perk is active (skip in lite create preview)
    if (!seeAll && raid.perkMods.fogPenalty > 0) {
      // Anchor to the settled Friend cell — never the mid-jump lerp —
      // so the black ring doesn't pump during hops.
      const friendScreen = mapRefToCanvas(
        cellCenter(raid.friend.x, raid.friend.y),
        ox,
        oy,
        fit,
      )

      // Fixed screen radius (vision × constant). Do NOT derive from cell
      // perspective — that shrinks the ring when jumping deeper.
      const visionScreenR = 46 * fit * Math.max(1, raid.friend.vision)
      drawVisionFalloff(ctx, friendScreen, visionScreenR, width, height)

      // Front apron → solid black once it leaves Friend vision
      const apronDark = apronOutOfVisionDarkness(raid.friend.x, raid.friend.vision)
      if (apronDark > 0.01) {
        ctx.save()
        ctx.globalAlpha = apronDark
        fillFrontApron(ctx, ox, oy, fit, height, '#000000')
        ctx.restore()
      }
    }

    // Fog perk: dark soft veil over everything outside current vision
    if ((!revealAll || liteFogPreview) && raid.perkMods.fogPenalty > 0) {
      const intensity = Math.min(3, raid.perkMods.fogPenalty)
      const timeMs = fogTimeRef.current || performance.now()
      const eye = fogEyesRef.current
      const vision = Math.max(1, raid.friend.vision)

      for (let depth = MAP_W - 1; depth >= 0; depth--) {
        for (let lane = 0; lane < MAP_H; lane++) {
          if (isCurrentlyVisible(raid.friend, depth, lane)) continue
          const dist = chebyshev(raid.friend, { x: depth, y: lane })
          const density = Math.min(1, Math.max(0, (dist - vision) / 4))
          const q = toCanvasQuad(depth, lane)
          drawFogSubstance(ctx, q, depth, lane, timeMs, intensity, density, fit, fogAlphaScale)
        }
      }

      if (eye && !isCurrentlyVisible(raid.friend, eye.x, eye.y)) {
        const age = timeMs - eye.born
        const fadeIn = Math.min(1, age / 140)
        const fadeOut = Math.min(1, (eye.life - age) / 200)
        const opacity = Math.max(0, Math.min(fadeIn, fadeOut)) * (liteFogPreview ? 0.75 : 1)
        drawFogEyes(ctx, eye.x, eye.y, opacity, ox, oy, fit, timeMs)
      }
    }

    ctx.restore()
  }, [
    raid,
    highlights,
    jumpAnim,
    friendHurt,
    hurtMobId,
    dashTrail,
    enduranceShield,
    enduranceBreakT,
    rallyBurstId,
    rallyFlags,
    boardOpacity,
    pitCliffStyle,
    revealAll,
    liteFogPreview,
    width,
    height,
    ready,
    fogTick,
    idleTick,
    enduranceAnimTick,
    rallyAnimTick,
    auraAnimTick,
    dodgeAnimTick,
    dodgeBurstId,
    clawsAnimTick,
    clawsBurstId,
    rallyBurstId,
  ])

  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      className="dungeon-canvas"
      aria-label="Dungeon map"
    />
  )
}
