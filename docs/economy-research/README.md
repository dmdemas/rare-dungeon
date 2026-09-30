# RF Dungeon-Stake — Economy Research

Эта папка содержит все исследования, симуляции и обоснования экономических решений.
Используется как база для статьи об игровой механике и экономике.

## Структура

| Файл | Содержание |
|------|-----------|
| `01-combat-balance.md` | Баланс боя: шанс клира, STA, перки, данж-уровни |
| `02-soft-economy.md` | Soft-режим: clear rate, ROI владельца/рейдера |
| `03-hard-economy.md` | Hard-режим: банк, налог, ROI, golden standard |
| `04-ticket-system.md` | Система билетов: минт-расписание, пул, распределение |
| `05-hold-curve.md` | Исследование кривой удержания данжа |
| `06-corridor-safety.md` | Защита от непроходимых карт |
| `07-final-numbers.md` | Финальные цифры и параметры |
| `08-dispersion-control.md` | Борьба с дисперсией сложности карт: генерация, калибровка, пулы пресетов |

## Инструменты симуляции

Все скрипты запускаются через `npx tsx scripts/<name>.ts`.

| Скрипт | Что делает | Ключевой результат |
|--------|-----------|-------------------|
| `sim-soft-verify.ts` | 1k Soft игр | Clear 33%, owner ~0.6× avg |
| `sim-soft-10k.ts` | 10k Soft | Точность clear rate |
| `sim-hard.ts` | Hard баланс | Clear 11%, раидер 9× |
| `sim-hard-floors-1k.ts` | Hard по этажам | F1 30% / F2 60% / F3 90% смерть |
| `sim-hard-tickets-1k.ts` | Билеты 1k | Hold-bonus, risk-boost |
| `sim-hard-tickets-hold-sweep.ts` | Sweep параметров билетов | Лучшая кривая hold-incentive |
| `sim-hard-hold-curve.ts` | Hold кривая налога | `--search`, `--search2`, `--final` |
| `sim-hard-targets.ts` | Hard golden standard | Все метрики vs. цели |
| `sim-impossible-check.ts` | Непроходимые карты | 0/4000 без пути, 24/400 нулевой клир |
| `sim-parity-skew.ts` | Перекос создание/рейды | Рычаги давления |
| `sim-parity-behavior.ts` | Behavior 1k с людьми | Claimer/holder/whale/raider types |
| `sim-final-economy.ts` | Полный цикл Soft+Hard | Итоговая таблица |
| `calibrate-pool.ts` | 10k карт → отбор по проходимости | σ Soft 21.8→3.9%, Hard 8.1→2.3% |
| `gen-world-snapshots.ts` | Симуляция живого мира на пулах | Стартовый мир + лента, 4 стабильных прогона |

## Чаты, в которых принимались решения

| Чат | UUID | Что решалось |
|-----|------|-------------|
| Corridor Safety + Soft/Hard balance | `563f23f2-2bf7-44da-b9a3-f364b7e36fbc` | Soft STA=20, perks, corridor safety |
| Эта сессия (пул и билеты) | текущий | Ticket system, near-lock tax, burn |
| Дисперсия карт и живой мир | `45d7fef1-407b-4056-96b2-6c1262037811` | Правила генерации, калибровка 10k, пулы пресетов, снимки мира |
