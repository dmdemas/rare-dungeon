ПеркиНа этаже выпадают 2 случайных перка из пула выбранной стороны. Повторы можно.
Взял тот же перк снова — линия качается I → II → III.
Цифры не плюсуются пачкой: действует только текущий уровень.
Выше III нельзя. Если перк уже III — замени карточку другим по тем же весам.
Игрок и данж имеют разные пулы.Вероятность выпадения перков случайная. У Friend свой пул из 6 перков, у Dungeon свой пул из 6 перков. Игроку не могут выпасть перки от данжа, как и наоборот.
На выбор всегда 2 разных перка на выбор.
Если в этом раунде выбран перк X, а в следующем выбран тот же перк X — перк улучшается до следующего уровня.База Friend: Vision 5, Stamina 20, Attack 1. Жизнь = стамина.
Итоговое зрение: max(1, 5 + Обзор − Туман).Две карточки на этаже — два независимых ролла.text

playerWeights = {
  vision: 20, stealth: 20, fright: 20, stamina: 20, damage: 20, wallbreak: 5
}
dungeonWeights = {
  fog: 20, extraMob: 20, mobDamage: 20, mobHp: 20, spikes: 20, minotaur: 5
}


FriendFearless
Type: Defense
Меньше шанс отпрыгнуть от монстра. Страх может быть 0%. Дистанция отпрыга от итогового страха: ≤25% → 1 клетка; выше (в т.ч. >50%) → 2 клетки.
База испуга 50%.
I: −25% · II: −50% · III: −75%
Картинка: assets/refs.perk/PerksFriend по имени FearlessDash
Type: Mobility
После урона шаги к выходу без стамины. В стену и в моба нельзя. Один раз за удар.
I: 2 шага · II: 3 шага · III: 4 шага
Картинка: assets/refs.perk/PerksFriend по имени DashSharp Eye
Type: Vision
Дальность зрения. Итог: max(1, 5 + глаз − туман).
I: +1 · II: +2 · III: +3
Картинка: assets/refs.perk/PerksFriend по имени Sharp EyeEndurance
Type: Stamina
Запас стамины. Только текущий ранг.
I: +2 · II: +3 · III: +4
Картинка: assets/refs.perk/PerksFriend по имени EnduranceRally
Type: Recovery
Стамина за убийство моба. Не выше максимума.
I: +1 · II: +1, максимум 2 раза за этаж · III: +2, без лимита этажа
Картинка: assets/refs.perk/PerksFriend по имени RallyDodge
Type: Defense
Шанс не получить удар моба. Без шага и без пропуска тика.
I: 25% · II: 50% · III: 75%
Картинка: assets/refs.perk/PerksFriend по имени DodgeDungeonDreadful Beasts
Type: Control
Выше шанс испуга и отпрыжки. Итог: clamp(50 + страх − бесстрашие, 0, 95). Дистанция отпрыга: ≤25% → 1 клетка; выше (в т.ч. >50%) → 2 клетки.
I: +25% · II: +50% · III: +75%
Картинка: assets/refs.perk/PerksDungeon по имени Dreadful BeastsSharp Claws
Type: Offense
Бонус к урону всех мобов (к базе, не замена).
I: +1 · II: +2 · III: +3
Картинка: assets/refs.perk/PerksDungeon по имени Sharp ClawsFog
Type: Vision
Режет зрение Friend. Ниже 1 не падает.
I: −1 · II: −2 · III: −3
Картинка: assets/refs.perk/PerksDungeon по имени FogThick Hide
Type: Defense
Бонус к HP всех мобов (к базе, не замена).
I: +1 · II: +2 · III: +3
Картинка: assets/refs.perk/PerksDungeon по имени Thick HideWalls
Type: Map
Лишние стены. Не на вход, выход и единственный коридор. Путь к выходу обязан остаться. Нет клетки — не ставить. Число равномерно из диапазона.
I: 2–4 · II: 4–6 · III: 6–8
Картинка: assets/refs.perk/PerksDungeon по имени WallsHorde
Type: Spawn
Лишние мобы на свободный пол. Не на вход, выход и единственный коридор.
I: +1 · II: +2 · III: +3
Картинка: assets/refs.perk/PerksDungeon по имени Horde


PlayПри заходе в режим Play на первом уровне игроку дается 2 перка на выбор. Он нажимает на один из них, и перк отображается в перках игрока снизу (снизу есть 3 иконки — смотреть референс
C:\Users\dieso\OneDrive\Рабочий стол\RF dungeon-stake\assets\refs.perk\FriendPerkSelection.png
и
C:\Users\dieso\OneDrive\Рабочий стол\RF dungeon-stake\assets\refs.perk\FriendPerkSlot.png).Первый раунд игрока. Появляется Fade in выбора перков. После того как игрок нажмет — появляется картинка выбранного перка снизу на perk slot в первом левом перке игрока (остальные perk slot на первом раунде пустые). Также fade in появляется первый перк данжа и применяется эффект к карте (перки данжа — правая часть картинки perk slot for dungeon, первый слева — референс
C:\Users\dieso\OneDrive\Рабочий стол\RF dungeon-stake\assets\refs.perk\whereperksareplacedduringplay.png).Второй раунд игрока. Появляется Fade in выбора перков. После того как игрок нажмет — появляется картинка выбранного перка снизу на perk slot во втором perk slot слева (остается один пустой perk slot слева у игрока и 2 пустых у данжа). Также fade in появляется второй перк данжа и применяется эффект к карте (остается один пустой perk slot самый правый). Перки данжа — правая часть картинки perk slot for dungeon, первый слева — референс
C:\Users\dieso\OneDrive\Рабочий стол\RF dungeon-stake\assets\refs.perk\whereperksareplacedduringplay.png.Третий раунд игрока. Появляется Fade in выбора перков. После того как игрок нажмет — появляется картинка выбранного перка снизу на perk slot в третьем perk slot слева (все старые перки остаются). Также fade in появляется третий перк данжа и применяется эффект к карте. Перки данжа — правая часть картинки perk slot for dungeon, все заполнены — референс
C:\Users\dieso\OneDrive\Рабочий стол\RF dungeon-stake\assets\refs.perk\whereperksareplacedduringplay.png.Создание данжа и выбор перковПосле того как игрок начал создать данж и выбрал один из данжей, появляется данж с выбором двух перков. Справа снизу перки данжа (референс
C:\Users\dieso\OneDrive\Рабочий стол\RF dungeon-stake\assets\refs.perk\DungeonPerkSelection.png
и
C:\Users\dieso\OneDrive\Рабочий стол\RF dungeon-stake\assets\refs.perk\DungeonPerkSlot.png).После выбора первого перка эффект применяется к карте — первый perk slot снизу заполняется.
Меняется цифра на раунд 2. После выбора второго перка эффект применяется к карте — второй perk slot снизу заполняется.
Меняется цифра на раунд 3. После выбора третьего перка эффект применяется к карте — третий perk slot снизу заполняется. Все perk slot справа снизу заполнены — создать карту через Enter.Перки FriendБесстрашие — меньше шанс отпрыгнуть от монстра.
База испуга задаётся отдельно (нужна одна цифра на игру, например 50%). Бесстрашие режет этот шанс, ниже 0% не падает.
I: −25%
II: −50%
III: −75%Рывок — после получения урона шаги к выходу без стамины.
В стену и в моба нельзя. Один раз за удар. Это единственный перк на бесплатное движение после контакта.
I: 2 шага
II: 3 шага
III: 4 шагаЗоркий глаз — дальность зрения.
Итог: max(1, база + глаз − туман).
I: +1
II: +2
III: +3Выносливость — запас стамины.
Действует только текущий уровень, бонусы карт не складываются.
I: +2
II: +3
III: +4Воодушевление — стамина за убийство моба.
Не чаще 1 раза за убийство. Не лечит сверх максимума стамины.
I: +1
II: +1, но не больше 2 восстановлений за этаж
III: +2, без лимита на этажУклонение — шанс не получить урон от монстра.
Только иммунитет к этому удару. Без бесплатного шага и без пропуска тика. Шаг после контакта даёт только Рывок.
I: 25%
II: 50%
III: 75%Перки данжаСтрашные монстры — выше шанс испуга и отпрыжки назад.
Плюсуется к той же базе, что режет Бесстрашие. Итоговый шанс: clamp(база + страх − бесстрашие, 0, 95).
I: +25%
II: +50%
III: +75%Острые когти — бонус к урону всех мобов.
К базе моба, не замена «урон = 2».
I: +1
II: +2
III: +3Туман — режет зрение Friend.
Ниже 1 зрение не падает.
I: −1
II: −2
III: −3Толстые монстры — бонус к HP всех мобов.
К базе моба, не «у всех HP = 2».
I: +1
II: +2
III: +3Стены — лишние стены.
Не ставить на вход, выход и единственный коридор. После спавна путь к выходу обязан остаться. Если валидной клетки нет — стену не ставить.
I: 2–4
II: 4–6
III: 6–8Орда — лишние мобы.
На свободный пол. Не на вход, выход и не на единственный коридор.
I: +1
II: +2
III: +3Тултип при выбореПри наведении мыши на карточку перка открывается маленькое окно с типом, текстом и рангами.Режим Play, выбор перка для Friend — тултип перков Friend.
Режим Create Dungeon, выбор перка для данжа — тултип перков данжа.Чужой пул не показывать. Текст только на английском.Формат окна:

Name
Type: …
One short rule.
I / II / III

Только текущая линия. Без лора. Без формул кода.Friend (Play)Fearless
Type: Defense
Reduces the chance to flinch back from a monster. Fear can go to 0%. Hop length from total fear: ≤25% → 1 cell; above 25% (incl. >50%) → 2 cells.
I: −25% · II: −50% · III: −75%Dash
Type: Mobility
After taking damage, move toward the exit without spending stamina. Cannot enter a wall or a monster. Once per hit.
I: 2 steps · II: 3 steps · III: 4 stepsSharp Eye
Type: Vision
Increases vision range and reduces the chance to flinch from a monster. Vision cannot drop below 1.
I: +1 vision, −5% flinch · II: +2 vision, −10% flinch · III: +3 vision, −15% flinchEndurance
Type: Stamina
Raises max stamina. Only the current rank applies.
I: +2 · II: +3 · III: +4Rally
Type: Recovery
Restore stamina when a monster dies. Cannot go above max stamina.
I: +1, max 2 times per floor · II: +2, max 2 times per floor · III: +3, max 2 times per floorDodge
Type: Defense
Chance to ignore a monster hit. No free step. No skipped tick.
I: 25% · II: 50% · III: 75%Dungeon (Create Dungeon)Dreadful Beasts
Type: Control
Increases the chance Friend flinches back. Total fear chance is capped at 95%. Hop length from total fear: ≤25% → 1 cell; above 25% (incl. >50%) → 2 cells.
I: +25% · II: +50% · III: +75%Sharp Claws
Type: Offense
All monsters deal extra damage.
I: +1 · II: +2 · III: +3Fog
Type: Vision
Shortens Friend’s vision and raises the chance Friend flinches from a monster. Vision cannot drop below 1. Total fear chance is capped at 95%.
I: −1 vision, +5% flinch · II: −2 vision, +10% flinch · III: −3 vision, +15% flinchThick Hide
Type: Defense
All monsters gain extra HP.
I: +1 · II: +2 · III: +3Pits
Type: Map
Adds extra pit cells. Never on entrance, exit, monsters, or the only path. A route to the exit must remain. Pits are rolled once and stay fixed on the map.
I: 2–4 · II: 4–6 · III: 6–8Horde
Type: Spawn
Adds extra monsters on free floor tiles. Not on entrance, exit, or the only corridor.
I: +1 · II: 2–3 (50%) · III: 3–4 (50%)Ховер по карточке = показать тултип рядом с картой, не перекрывая кнопки выбора.
Уход мыши = скрыть.
Если перк уже взят, в тултипе подсветить текущий ранг и следующий.
Пример: есть Dash I → показать, что выбор даст Dash II (3 steps).
Если ранг уже III, эту карточку не предлагать; тултип III не нужен на выборе.
Две карточки на экране — у каждой свой тултип.Не выдумывать новые перки и не менять цифры.
Не писать русский текст в UI.
Type брать только из списка выше.
Friend и данж не смешивать.

Откуда брать картинки перков6 перков для данжа, все подписаны по названиям, брать отсюда:
C:\Users\dieso\OneDrive\Рабочий стол\RF dungeon-stake\assets\refs.perk\PerksDungeon6 перков для Friend, все подписаны по названиям, брать отсюда:
C:\Users\dieso\OneDrive\Рабочий стол\RF dungeon-stake\assets\refs.perk\PerksFriendИскать файл по названию перка и вставлять эту картинку:на карточку выбора, когда перк выпал на выбор
в perk slot, когда перк выбран / выдан
Play: Friend-картинка из PerksFriend в левые слоты игрока; данж-картинка из PerksDungeon в правые слоты данжа
Create Dungeon: только картинки из PerksDungeon в слоты данжа справа снизу

Чужие папки не мешать. Не подписывать перк другой картинкой. Если файл не найден по имени — не подставлять соседний перк.