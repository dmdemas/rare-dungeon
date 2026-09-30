# 06 — Corridor Safety (Защита от сложных карт)

## Проблема

Некоторые карты имеют длинные BFS-пути (коридорный тип) с высокой концентрацией стен.
На таких картах шанс прохождения с Horde+Walls перками падает до ~0%.

## Результаты sim-impossible-check.ts

- Phase 1: BFS на **4000 blueprints** → 0 карт без пути (все проходимы)
- Phase 2: Walls perk на **500 карт** → 0 заблокированных
- Phase 3: **400 карт × 50 попыток × multi-perk** → 24/400 zero-clear (все Hard, причина F3 STA=13)

## Детектор (computeCorridorFlag)

```typescript
// mapGen.ts
export function computeCorridorFlag(tiles: TileKind[]): boolean {
  const wallCount = tiles.filter(t => t === 'wall').length
  if (wallCount < 10) return false
  const path = bfsPath(entrance, exit, walkable)
  return path !== null && path.length - 1 >= 18
}
```

Trigger: `pathLen ≥ 18 AND walls ≥ 10`

## Рычаги защиты

| Рычаг | Normal | Corridor |
|-------|--------|---------|
| Walls rank 1 | 5 (mid 4–6) | **4** |
| Walls rank 2 | 7 (mid 6–8) | **6** |
| Walls rank 3 | 9 (mid 8–10) | **8** |
| Horde rank 2–3 | 2–3 мобов | **всегда 2** |
| Horde offer weight | 1.0 | **×0.50 (−50%)** |
| Walls offer weight | 1.0 | **×0.65 (−35%)** |

## Threading в коде

```typescript
// mapGen.ts → generateBlueprint → isCorridor
// effects.ts → rollHordeCount(rank, rng, dangerMap)
// effects.ts → derivePerkMods({ dangerMap }) → WALLS_EXTRA_MIN
// offer.ts → rollOffer(..., dangerMap) → weighted picks
// state.ts → rollDungeonOffer(state, rng, dangerMap)
// state.ts → rollPredefinedDungeonPerks(rng, dangerMap)
// raid.ts → startRaid → raid.isCorridor = bp.isCorridor
// sync.ts → derivePerkMods({ ..., dangerMap: raid.isCorridor })
// CreateDungeon.tsx → rollOffer(..., selected.isCorridor)
// RaidView.tsx → rollPredefinedDungeonPerks(rng, blueprint.isCorridor)
```
