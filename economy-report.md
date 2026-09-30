# Отчёт: Soft/Hard экономика + owner share pool

Дата: 2026-09-29  
Симы: `npx tsx scripts/sim-economy-tiers.ts`  
Боевой якорь (ранее): `npx tsx scripts/sim-perk-balance.ts` ≈ Friend **5.3%** smart/smart.

---

## 1. Вердикт

| Вопрос | Ответ |
|---|---|
| Можно ли сделать то, что ты описал? | **Да** |
| Жизнеспособность (0–100) | **78** (было ~72; +share pool для hold) |
| Что обязательно | Hybrid: часть entry в **банк**, часть в **owner pool**; Soft WR > Hard WR; 20/80 Soft/Hard shares |
| Что опасно | 100% entry в pool (pure) — слабый куш + в симе CLAIMY может обогнать HOLD |

**Итог:** модель рабочая. Канон записан в `economy.md`. Ниже — цифры сима, как добиться WR, что добавить в игру.

---

## 2. Твоя идея с пулом владельцев

Ты предложил: деньги с **рероллов** и с **заходов** → общий пул → **~20% Soft / ~80% Hard**, доли по числу **live** данжей.

Это хорошо бьёт в удержание:

- больше live Hard → больше пассива;
- «Забрать» = убить свою долю;
- create ещё один Hard = ещё одна доля 80%-котла.

### Конфликт с банком

Если **100%** entry уходит владельцам, банк почти не растёт → нечего «выносить» кроме create-стейка ($2 / $20).

**Канон — hybrid:**

| | Soft $1 entry | Hard $10 entry |
|---|---|---|
| В банк данжа | $0.35 | $3.50 |
| В owner pool | $0.55 | $5.50 |
| Protocol | $0.10 | $1.00 |

Рероллы Create/Friend → **100% owner pool**.

---

## 3. Иерархия шансов Friend (важно)

| | Clear p |
|---|---|
| Soft | **~32%** |
| Hard без реролла | **~7%** |
| Hard макс. реролл | **≤20%** (< Soft) |

Soft выигрывается чаще → хочется идти в Hard уже «умея» перки, рероллить офферы за большой куш, но Hard **всегда** жёстче Soft.

---

## 4. Результаты сима (world, 40 owners)

### Hybrid (рекомендован)

| Метрика | Soft | Hard |
|---|---|---|
| Mean effective clear p | **0.320** | **0.117** |
| Mean shares / данж | ~$4.5 | ~$50 |
| Mean bank claim / данж | ~$0.2 | ~$0 |
| Owner profit mean | **~$27** | (в смеси 1+1) |
| **HOLD EV** | | **$33.7** |
| **CLAIMY EV** | | **$14.1** |

→ Soft p > Hard p.  
→ **Держать выгоднее, чем рано забирать** — твоя мотивация подтверждена.

### Pure (100% entry → pool) — не канон

- Hard shares ещё жирнее (~$93/данж).
- Но **CLAIMY EV > HOLD** в прогоне → стимул «не забирать» ломается на краях.
- Куш рейдера бедный (банк ≈ create).

### Soft-farm (3 Soft, 0 Hard)

- Mean profit автора **≈ −$0.2**, P(+) 25%.  
- Ферма одних Soft без Hard **не печатает** (80% котла некуда / мало ценности).

---

## 5. Целевые распределения (продуктовые)

### Soft автор (create $2)

| Исход | Ожидание |
|---|---|
| Основной доход | **shares**, пока данж live |
| Bank claim при mid close | модально порядка **$3–5** суммарно с малым банком |
| Риск | clear ~1 из 3 рейдов при p=32% → банк уносят часто, если не закрыл |
| Стратегия | держать для shares **или** close после нескольких трупов — UI должен показывать «lose shares if close» |

Старая цель «чаще всего забрать ровно $5 с банка» **смягчена**: $5-ощущение = **bank claim + накопленные shares**. Иначе при 32% clear банк alone нестабилен (это показал первый Monte Carlo без pool).

### Hard автор (create $20)

| Исход | Ожидание |
|---|---|
| Основной доход | **shares 80%-котла** |
| Bank claim | редко толстый, если hold; при clear — 0 с банка |
| ROI | в симе hold-mixed прибыльна при живом трафике рейдов |
| Create reroll | платишь в pool → чуть сильнее база данжа → дольше live → больше shares |

### Рейдер

| | Soft | Hard |
|---|---|---|
| Цена попытки | $1 | $10 (+рероллы) |
| Шанс | выше | ниже даже с рероллом |
| Куш | маленький банк | банк + эмоциональный jackpot; week tickets за clear |

---

## 6. Как добиться WR в бою (не в экономике)

| Тир | Сейчас в коде | Цель | Действие |
|---|---|---|---|
| Hard base | ~5% smart/smart | 6–8% | почти ок; тонкая калибровка перков Hard |
| Hard after Friend reroll | нет системы реролла | ≤20% | реролл оффера; кап по симу перков, не «+p за $» |
| Soft | тот же бой ~5% | **30–34%** | отдельный Soft loadout: слабее dungeon perks / меньше мобов / те же 3 слота без усиления |

Без **раздельного** баланса Soft/Hard экономика цифрами не взлетит.

---

## 7. Что добавить в игру (чтобы заработало)

### Обязательно (MVP экономики)

1. **Тиры Soft/Hard** в Create и Play (цены $2/$1 и $20/$10).  
2. **Раздельные пулы** списков данжей + казённый Soft filler.  
3. **Сплит entry** → bank / ownerPool / protocol (`economy.md`).  
4. **Owner pool epoch** + UI: «мои live shares Soft/Hard», таймер эпохи, оценка доли.  
5. **Close** убивает share; копирайт в UI.  
6. **Hard create reroll** перков (+50%/шаг) → pool.  
7. **Hard Friend reroll** оффера до боя (+50%/шаг, кап p≤20%) → pool.  
8. Провод баланса RF/$ stub в меню (spent, burned, pool, shares accrued).  
9. Метрики: clear p Soft/Hard, HOLD vs CLOSE, soft-farm profit.

### Желательно рядом

10. Historical clear rate на карточке данжа.  
11. Hard clear = 2–3 week ticket.  
12. Подсказка graduation Soft → Hard.

### Не делать в v1

- 6 слотов перков (оставить 3, усилить Hard цифры).  
- Mid-combat pay-to-win.  
- Свободный стейк.  
- Страховка/daily.  
- Pure 100% entry→pool как default.

---

## 8. Порядок реализации (инженерно)

1. `economy.ts` — константы тиров, splitFee, ownerPool epoch (чистые функции).  
2. App state — balance, pool, live dungeon meta (tier, wins, bank, sharesAccrued).  
3. Create/Play UI — выбор тира + цены.  
4. Raid entry debit + split.  
5. Reroll offer flow (Hard).  
6. Epoch ticker + payout shares.  
7. Soft balance pass (map/perks) до clear≈32%.  
8. Подключить `sim-economy-tiers` + `sim-perk-balance` в CI/скрипты npm.

Код боя можно не трогать до шага 7, кроме флага тира на blueprint.

---

## 9. Риски и страховки

| Риск | Страховка |
|---|---|
| Все штампуют Soft для 20% | лимит 3 live; 80% Hard; soft-farm в симе ≈0 EV |
| Hard реролл до 20% слишком дешёвый | эскалация ×1.5; мало шагов до капа |
| Никто не рейдит Hard | казна Soft для онбординга; UI показывает fat shares/banks Hard |
| Авторы никогда не close | win-cap + soft suggest; shares уже дают hold-pay |
| Пулл эпох пустой | казённые Soft; rollover Soft↔Hard |

---

## 10. Итоговая оценка

Сделать **можно**. Связка:

- **Soft 32% / дешёво** = школа и объём  
- **Hard 7→≤20% / дорого** = куш + реролл skill  
- **Owner pool 20/80 по live** = держать и плодить Hard  
- **Hybrid bank** = рейдеру всё ещё есть что выносить  

До **~85+** жизнеспособности дотянет только после: боевого Soft-баланса до ~32%, UI shares, и 1–2 недель метрик HOLD≥CLAIMY на реальных игроках.

Канон правил: [`economy.md`](./economy.md)  
Сим: [`scripts/sim-economy-tiers.ts`](./scripts/sim-economy-tiers.ts)
