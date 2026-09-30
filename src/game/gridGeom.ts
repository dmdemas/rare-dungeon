import { MAP_H, MAP_W } from './config'

export type Pt = { x: number; y: number }

/**
 * LOCKED walk trapezoid (approved). Do not change — see .cursor/rules/dungeon-grid.mdc
 * Stretched like dungeon.png corridor (1777×885).
 */
export const REF = {
  w: 1777,
  h: 885,
  nearY: 742,
  nearL: 762,
  nearR: 1016,
  farY: 108,
  farL: 790,
  farR: 985,
}

export function rowEdge(t: number) {
  const y = REF.nearY + (REF.farY - REF.nearY) * t
  const left = REF.nearL + (REF.farL - REF.nearL) * t
  const right = REF.nearR + (REF.farR - REF.nearR) * t
  return { y, left, right, width: right - left }
}

/** Cell quad in REF space: [tl, tr, br, bl]. depth = entrance→exit, lane = lateral. */
export function cellQuad(depth: number, lane: number): [Pt, Pt, Pt, Pt] {
  const t0 = depth / MAP_W
  const t1 = (depth + 1) / MAP_W
  const near = rowEdge(t0)
  const far = rowEdge(t1)
  const nCell = near.width / MAP_H
  const fCell = far.width / MAP_H
  const bl = { x: near.left + lane * nCell, y: near.y }
  const br = { x: near.left + (lane + 1) * nCell, y: near.y }
  const tr = { x: far.left + (lane + 1) * fCell, y: far.y }
  const tl = { x: far.left + lane * fCell, y: far.y }
  return [tl, tr, br, bl]
}

export function cellCenter(depth: number, lane: number): Pt & { scale: number } {
  const mid = rowEdge((depth + 0.5) / MAP_W)
  const cell = mid.width / MAP_H
  const x = mid.left + (lane + 0.5) * cell
  const y = mid.y
  const nearW = rowEdge(depth / MAP_W).width / MAP_H
  return { x, y, scale: nearW / ((REF.nearR - REF.nearL) / MAP_H) }
}

export function mapRefToCanvas(p: Pt, ox: number, oy: number, s: number): Pt {
  return { x: ox + p.x * s, y: oy + p.y * s }
}

export function mapQuad(q: [Pt, Pt, Pt, Pt], ox: number, oy: number, s: number): [Pt, Pt, Pt, Pt] {
  return q.map((p) => mapRefToCanvas(p, ox, oy, s)) as [Pt, Pt, Pt, Pt]
}

/** Same camera fit as DungeonCanvas: letterbox REF into the viewport. */
export function fitRefCamera(width: number, height: number) {
  const fit = Math.min(width / REF.w, height / REF.h)
  const ox = (width - REF.w * fit) / 2
  const oy = (height - REF.h * fit) / 2
  return { fit, ox, oy }
}
