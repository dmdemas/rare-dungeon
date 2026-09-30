# 01 — Боевой баланс

## Подтверждено на 10 000 симуляций

### Soft режим

| Параметр | Значение | Источник |
|----------|---------|---------|
| Clear rate (Friend побеждает) | **33%** | `sim-soft-verify.ts` |
| Смерть на F1 | ~43% | `sim-soft-perks-floors-1k.ts` |
| Смерть нарастающим итогом F2 | ~70% | — |
| Смерть нарастающим итогом F3 | ~90% | — |
| Базовая STA | **20** (все этажи) | `economy.ts::SOFT_FLOOR_STAMINA` |
| dungeonEfficacy | **6.5** | калибровка sweep 1×1k |

### Hard режим

| Параметр | Значение | Источник |
|----------|---------|---------|
| Clear rate (Friend побеждает) | **11%** | `sim-hard.ts`, 10k |
| Смерть F1 | ~30% | `sim-hard-floors-1k.ts` |
| Смерть нарастающим итогом F2 | ~60% | — |
| Смерть нарастающим итогом F3 | ~90% | — |
| STA F1/F2/F3 | **20/17/13** | `economy.ts::HARD_FLOOR_STAMINA` |
| dungeonPowerScale | **2.3** (abs=0.92) | `economy.ts::HARD.dungeonPowerScale` |

## Ключевые решения

### Почему STA Hard F3 = 13?
Это основная причина сложности Hard. Нарочно занижено для ~11% clear rate.
Увеличение до 15 поднимает clear rate до ~18% (слишком много).

### Corridor Safety
Карты с BFS-путём ≥18 клеток AND стен ≥10 → опасные коридорные карты.
Снижение: Horde min-count, Walls min-count, -50%/-35% к вероятности выпадения перков.
Файл: `src/game/perks/effects.ts`, `src/game/mapGen.ts::computeCorridorFlag`.

### Impossibility check (sim-impossible-check.ts)
- Phase 1: BFS на 4000 blueprints → 0 без пути
- Phase 2: Walls perk на 500 → 0 заблокированных
- Phase 3: 400 данжей × 50 попыток → 24/400 zero-clear (все Hard F3=13)
- Вывод: "непроходимые" карты существуют только в Hard при неудачных перках

## Константы (финальные, утверждены)

```typescript
// Hard floor stamina
HARD_FLOOR_STAMINA = [0, 20, 17, 13]

// Soft floor stamina (flat)
SOFT_FLOOR_STAMINA = [0, 20, 20, 20]

// dungeonEfficacy (Soft only)
SOFT.dungeonEfficacy = 6.5

// Corridor safety thresholds
BFS_PATH_LEN_THRESHOLD = 18
WALL_COUNT_THRESHOLD = 10
```
