import { useEffect, useRef, useState } from 'react'
import { BASE_VISION, MAP_H, MAP_W } from '../game/config'
import {
  REF,
  cellCenter,
  cellQuad,
  fitRefCamera,
  mapQuad,
  mapRefToCanvas,
  type Pt,
} from '../game/gridGeom'
import { getEntranceCell } from '../game/mapGen'
import { chebyshev, tileAt } from '../game/pathfinding'
import type { DungeonBlueprint } from '../game/types'

/** Same fills as the raid canvas (schematic cells only). */
const FLOOR_FILL = '#3a3a3a'
const FLOOR_STROKE = 'rgba(210,210,210,0.9)'
const ENTRANCE_FILL = '#2f6b3a'
const ENTRANCE_STROKE = 'rgba(120,220,140,0.95)'
const EXIT_FILL = '#4a4a52'
const EXIT_STROKE = 'rgba(220,200,120,0.95)'
const EXIT_MARK = 'rgba(230,210,100,0.55)'

function fillQuad(ctx: CanvasRenderingContext2D, q: [Pt, Pt, Pt, Pt], fill: string) {
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.moveTo(q[0].x, q[0].y)
  ctx.lineTo(q[1].x, q[1].y)
  ctx.lineTo(q[2].x, q[2].y)
  ctx.lineTo(q[3].x, q[3].y)
  ctx.closePath()
  ctx.fill()
}

function strokeQuad(ctx: CanvasRenderingContext2D, q: [Pt, Pt, Pt, Pt], stroke: string, lw: number) {
  ctx.strokeStyle = stroke
  ctx.lineWidth = lw
  ctx.lineJoin = 'miter'
  ctx.beginPath()
  ctx.moveTo(q[0].x, q[0].y)
  ctx.lineTo(q[1].x, q[1].y)
  ctx.lineTo(q[2].x, q[2].y)
  ctx.lineTo(q[3].x, q[3].y)
  ctx.closePath()
  ctx.stroke()
}

function drawFloorCell(
  ctx: CanvasRenderingContext2D,
  q: [Pt, Pt, Pt, Pt],
  fit: number,
  kind: 'floor' | 'entrance' | 'exit',
) {
  const line = Math.max(1, 1.5 * fit)
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
    strokeQuad(ctx, inner, EXIT_STROKE, Math.max(1, 1.1 * fit))
    return
  }
  fillQuad(ctx, q, FLOOR_FILL)
  strokeQuad(ctx, q, FLOOR_STROKE, line)
}

/** Zoom camera so visible fog cells fill the canvas (fortune reel). */
function fitVisibleCells(
  width: number,
  height: number,
  cells: { depth: number; lane: number }[],
) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { depth, lane } of cells) {
    for (const p of cellQuad(depth, lane)) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  if (!Number.isFinite(minX)) return fitRefCamera(width, height)
  const pad = 12
  const bw = Math.max(1, maxX - minX + pad * 2)
  const bh = Math.max(1, maxY - minY + pad * 2)
  const fit = Math.min(width / bw, height / bh)
  const ox = (width - (minX + maxX) * fit) / 2
  const oy = (height - (minY + maxY) * fit) / 2
  return { fit, ox, oy }
}

type Props = {
  blueprint: DungeonBlueprint
  selected?: boolean
  onClick?: () => void
  /** If true, only show cells within vision of entrance (Play pool fog). */
  fogOfWar?: boolean
  /** Draw a red marker under each mob (create layout pick). */
  markMobs?: boolean
  /** Layout pick only: mobs as red dots, no sprites. */
  mobsAsDots?: boolean
  /** Canvas only — no title/meta (fortune reel). */
  compact?: boolean
}

export function MapPreview({
  blueprint,
  selected,
  onClick,
  fogOfWar = false,
  markMobs = false,
  mobsAsDots = false,
  compact = false,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [spriteTick, setSpriteTick] = useState(0)
  const mobImg = useRef<HTMLImageElement | null>(null)
  const friendImg = useRef<HTMLImageElement | null>(null)
  // Same aspect as locked REF / raid camera
  const w = 520
  const h = Math.round((520 * REF.h) / REF.w)
  /** Schematic create/reel: no green entrance, no Friend sprite. */
  const schematic = mobsAsDots

  useEffect(() => {
    const bump = () => setSpriteTick((n) => n + 1)
    const load = (src: string, slot: { current: HTMLImageElement | null }) => {
      const img = new Image()
      img.onload = bump
      img.onerror = bump
      img.src = src
      slot.current = img
    }
    load('/sprites/mob.png', mobImg)
    if (!schematic) load('/sprites/friend.png', friendImg)
  }, [schematic])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.imageSmoothingEnabled = true
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)

    const entrance = getEntranceCell(blueprint.map.tiles)
    const vision = BASE_VISION
    const useFog = fogOfWar && !blueprint.isGridDemo

    // Always use full REF camera — fog just darkens out-of-vision cells
    const { fit, ox, oy } = fitRefCamera(w, h)
    const toCanvasQuad = (depth: number, lane: number) =>
      mapQuad(cellQuad(depth, lane), ox, oy, fit)

    // Far → near (same painter order as raid)
    for (let depth = MAP_W - 1; depth >= 0; depth--) {
      for (let lane = 0; lane < MAP_H; lane++) {
        const q = toCanvasQuad(depth, lane)
        const inVision = !useFog || chebyshev({ x: depth, y: lane }, entrance) <= vision

        if (!inVision) {
          fillQuad(ctx, q, '#050505')
          continue
        }

        const kind = tileAt(blueprint.map.tiles, depth, lane)
        if (kind === 'wall') {
          fillQuad(ctx, q, '#000000')
        } else if (kind === 'entrance') {
          drawFloorCell(ctx, q, fit, 'entrance')
        } else if (kind === 'exit') {
          drawFloorCell(ctx, q, fit, 'exit')
        } else {
          drawFloorCell(ctx, q, fit, 'floor')
        }
      }
    }

    const drawActor = (img: HTMLImageElement | null, depth: number, lane: number) => {
      if (!img?.complete || img.naturalWidth < 1) return
      const stand = cellCenter(depth, lane)
      const p = mapRefToCanvas(stand, ox, oy, fit)
      const cellW = ((REF.nearR - REF.nearL) / MAP_H) * stand.scale * fit
      const size = cellW * 0.85
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(img, p.x - size / 2, p.y - size * 0.72, size, size)
      return { x: p.x, y: p.y, cellW }
    }

    const drawMobDot = (depth: number, lane: number) => {
      const stand = cellCenter(depth, lane)
      const p = mapRefToCanvas(stand, ox, oy, fit)
      const cellW = ((REF.nearR - REF.nearL) / MAP_H) * stand.scale * fit
      const r = Math.max(3, cellW * 0.12)
      const y = p.y + cellW * 0.02
      ctx.beginPath()
      ctx.fillStyle = 'rgba(255, 40, 40, 0.35)'
      ctx.arc(p.x, y, r * 2.2, 0, Math.PI * 2)
      ctx.fill()
      ctx.beginPath()
      ctx.fillStyle = '#ff1a1a'
      ctx.arc(p.x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }

    // Mobs: full map in Create (no fog); Play fog only shows in-vision spawns
    const mobs = [...blueprint.mobSpawns].sort((a, b) => b.x - a.x || a.y - b.y)
    for (const m of mobs) {
      if (useFog && chebyshev(m, entrance) > vision) continue
      if (mobsAsDots) {
        drawMobDot(m.x, m.y)
        continue
      }
      const foot = drawActor(mobImg.current, m.x, m.y)
      if (markMobs && foot) {
        const r = Math.max(2.5, foot.cellW * 0.09)
        ctx.beginPath()
        ctx.fillStyle = '#ff1a1a'
        ctx.arc(foot.x, foot.y + foot.cellW * 0.02, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.beginPath()
        ctx.fillStyle = 'rgba(255, 60, 60, 0.35)'
        ctx.arc(foot.x, foot.y + foot.cellW * 0.02, r * 2.1, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    if (!schematic) {
      drawActor(friendImg.current, entrance.x, entrance.y)
    }
  }, [blueprint, fogOfWar, markMobs, mobsAsDots, schematic, compact, spriteTick])

  const className = `map-preview${selected ? ' selected' : ''}${compact ? ' map-preview--compact' : ''}`
  const body = (
    <>
      {!compact && <div className="map-preview-title">{blueprint.name}</div>}
      <canvas ref={ref} width={w} height={h} />
      {!compact && (
        <div className="map-preview-meta">
          {fogOfWar
            ? 'Fog of war · schematic'
            : `Walls ${blueprint.map.walls.size} · Mobs ${blueprint.mobSpawns.length}`}
        </div>
      )}
    </>
  )

  if (!onClick) {
    return <div className={className}>{body}</div>
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {body}
    </button>
  )
}
