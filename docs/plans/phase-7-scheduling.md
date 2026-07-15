# Этап 7: Запуск бизнес-процессов по расписанию

> ## ⚠️ Reference-дизайн «Минутки», не портирован под ассистента
>
> Документ написан в терминах старого продукта (`MinutkaService`, `employeeId`, трёхсторонняя privacy, `minutka_private`, `evening_reflection`/`morning_brief`) и **не является активным планом**. В roadmap ассистента планировщик — это **RFC Фаза D «Дайджест»** (`SchedulerService`, RFC §10), которая идёт **после** Фаз B (банк идей) и C (планирование). Реализовывать сейчас преждевременно.
>
> **Ядро дизайна переживает порт** и остаётся рекомендацией: планировщик как driving-адаптер поверх одной таблицы правил + леджер срабатываний в Postgres; тик + claim через `FOR UPDATE SKIP LOCKED`; правило — декларативная zod-схема (не cron/RRULE); `next_fire_at` — чистая функция на luxon; scheduled-запуск минует LLM-роутер и пишет ход в историю; Mastra — исполнитель, не планировщик.
>
> **Дельта порта при реализации Фазы D:**
> - `MinutkaService.runScheduledProcess` → `AssistantService`; `employeeId` → `userId`; guard consent/lifecycle → single-owner-модель (RFC §11).
> - Процессы: `evening_reflection`/`morning_brief` → навыки ассистента с триггером `scheduled` (`morning_digest`, `evening_reflection`, недельный обзор банка идей — RFC §8.1, §10).
> - Триггер `scheduled` в агент-ведомой модели ([rfc-agent-led-routing.md](../architecture/rfc-agent-led-routing.md)) — **детерминированный гейт входа** (расписание ⇒ запуск навыка планировщиком), а не purpose пре-флайт-роутера. Заход F2 из [fix-routing-catalog.md](./fix-routing-catalog.md) **snят** — расширять `assertPurpose`/`DecisionProcessId` для этого не нужно; к Фазе D роутинг уже агент-ведомый.
> - Схема БД: `minutka_private` — переиспользуемая физическая схема (решение RFC §14.1), но проверить owner-constraint по `userId`, а не `employeeId`.
> - **Перед реализацией — переоценить встроенный примитив Mastra Schedules** как альтернативу ручному воркеру (обязательное условие RFC §14.3); §4.7 ниже решает это в терминах «Минутки» и требует пересмотра.
>
> Ссылки `phase-5`/теги ниже — из контекста «Минутки»; для ассистента целевого тега `phase-7-scheduling` не будет, работа пойдёт под Фазой D.

> **Родительский план:** [time-agent-mastra-plan.md](./time-agent-mastra-plan.md)
> **Предыдущий этап:** [phase-5-voice-stt.md](./phase-5-voice-stt.md)
> **Стартовый тег:** `phase-5-voice-stt`
> **Целевой тег:** `phase-7-scheduling`

---

## 1. Цель этапа

Бот **сам инициирует** диалог в назначенное сотрудником время: вечерняя рефлексия в 19:00 и утренний бриф в 8:30 по локальному времени сотрудника, по выбранным дням недели, с заданной недельной периодичностью (в т.ч. «раз в две недели»).

Ключевое архитектурное решение: **расписание — это ещё один driving-адаптер, наравне с Telegram, CLI и админкой.** Срабатывание по времени — это входящее событие, которое конвертируется в вызов того же application use-case, что и сообщение пользователя. «Планировщик» не является ни частью Telegram, ни частью Mastra: это тонкий транспорт системного события поверх одной таблицы правил в Postgres. Источник истины о следующем запуске и об уже отработанных слотах — Postgres, а не in-memory таймер и не встроенный планировщик фреймворка.

Принципы этапа:

- **простой:** одна таблица правил + маленький леджер срабатываний; никаких очередей-библиотек (pg-boss / graphile-worker / BullMQ / Temporal); правило — декларативная zod-схема, а не cron-строка и не RRULE; расчёт следующего запуска — одна чистая функция;
- **надёжный:** идемпотентность — инвариант БД (`UNIQUE (schedule_id, scheduled_for)`), а не договорённость; безопасность при 2+ инстансах — через `FOR UPDATE SKIP LOCKED`, без leader election и advisory-локов; семантика at-most-once (пропуск дешевле дубля для человеко-уведомлений); все детерминированные проверки — **до** обращения к LLM;
- **эффективный:** тик делает один индексный запрос по материализованному `next_fire_at`, а не парсит все правила; LLM в цикле планирования не участвует; вечерний пинг — статический шаблон (0 токенов), LLM нужен только там, где касание опирается на контекст (утренний бриф).

---

## 2. Definition of Done

- [ ] Профиль сотрудника несёт `timezone` (IANA), собираемую на онбординге; проходит domain → contract → SDK → HTTP → проекции; добавлена миграция колонки.
- [ ] Добавлена dependency `luxon` (+ `@types/luxon`) для DST-корректной конверсии wall-clock → UTC.
- [ ] Чистая функция `computeNextRun(rule, timezone, after)` с табличными тестами: будни, «каждый второй понедельник» через границу года, весенний и осенний переход на летнее время.
- [ ] Миграции `process_schedules` и `schedule_fires` с privacy-safe грантами `minutka_runtime` (по образцу `0009_grant_runtime_role.sql`).
- [ ] Стор `ScheduleStore` (порт + Postgres-реализация): upsert правила, атомарный claim созревших слотов, вставка `schedule_fires` с `ON CONFLICT DO NOTHING`, пересчёт `next_fire_at` в одной транзакции.
- [ ] Новый use-case `MinutkaService.runScheduledProcess({ employeeId, processId, occurrenceKey })`: consent/lifecycle guard → детерминированный форс `[core, processId]` (без LLM-роутера) → формирование касания → запись ассистентского хода в `ConversationStore` → audit `scheduled_process_fired`.
- [ ] Порт исходящей доставки `MessageSender` в telegram-слое: резолв `employeeId → chatId` (обратный маппинг), отправка первого касания; `403` выключает расписания сотрудника, `429` — сон `retry_after` + один повтор.
- [ ] `schedule-dispatcher`: in-process тик 45–60 с в `serve.ts` (по образцу `draftCleanup`), с `unref()` и graceful shutdown до остановки Telegraf.
- [ ] Catch-up policy: слот в пределах `catch_up_window` — выполняется (помечается `late`), за пределами — `skipped` с пересчётом следующего.
- [ ] Новый vault-процесс `morning_brief` по контракту `process-authoring.md`; `evening_reflection` расширен на scheduled-purpose; обновлён `registry.json`.
- [ ] `AgentManualPurpose` расширен новым значением для scheduled-запуска; `DecisionProcessId` и `agentManualProcessIds` включают `morning_brief`.
- [ ] `SPEC-SCHEDULE-001` через fake `Clock`: чистая функция таблично; тик + claim на Postgres; двойной инстанс — два параллельных claim с ассертом на один запуск.
- [ ] Предыдущие specs остаются зелёными.
- [ ] `npm run typecheck`, `npm run specs`, `npm run verify`, `npm run verify:persistence`, `nix run .#verify` проходят.
- [ ] Ручной smoke: реальное расписание → бот пишет первым в назначенное время → ответ сотрудника продолжает тот же тред.
- [ ] Коммит и тег `phase-7-scheduling`.

---

## 3. Границы этапа

### Входит

1. `timezone` в профиле и онбординге (см. §4.1).
2. Декларативная модель правила `ScheduleRule` (zod) и чистая `computeNextRun` (см. §4.2).
3. Таблицы `process_schedules` / `schedule_fires` и `ScheduleStore` (см. §4.3).
4. Use-case `runScheduledProcess` (см. §4.4).
5. Порт `MessageSender` и обратный маппинг `employeeId → chatId` (см. §4.5).
6. `schedule-dispatcher` (тик + claim + catch-up) (см. §4.6).
7. Vault-процесс `morning_brief`; scheduled-purpose для `evening_reflection`.
8. `SPEC-SCHEDULE-001` и ручной smoke.

### Не входит

- **UI управления расписаниями.** На этом этапе расписание сотрудника создаётся дефолтами при завершении онбординга (одно вечернее касание по `preferredCheckinsPerDay`) и/или seed-конфигом; экран «⚙️ Настройки — время трёх касаний» — отдельный этап.
- **Per-user heartbeat** (периодический LLM-опрос по таймеру): не входит и сознательно не делается — для точного «в 19:00» нужен schedule, а не heartbeat; на ~100 пользователей heartbeat означал бы тысячи холостых LLM-вызовов в сутки.
- **at-least-once с персистентными ретраями, DLQ, приоритетами.** Дефолт этапа — at-most-once; ретрай-лестница и `consecutive_errors` — этап зрелости (§7).
- **cron-строки и RRULE** как формат правил (обоснование — §4.2).
- **Встроенный `mastra.schedules`** как источник истины (обоснование — §4.7).
- **RRULE-совместимость (monthly / nth-weekday / EXDATE / ICS).** План Б на вырост; модель правила изолирована за zod-схемой, чтобы это не стало переписыванием.
- **Отдельный процесс-планировщик** и service-эндпоинт `.../tick`: на этапе — in-process тик; вынос — §7 (тот же claim-код).
- **Напоминание «пропустил два дня подряд»** и «⏰ Позже» (snooze): естественно ложатся на `schedule_fires`, но продуктовые формулировки — отдельно.

---

## 4. Архитектурное решение

### 4.1 Таймзона в профиле и онбординге

`UserProfile` получает `timezone: string` (IANA, например `Europe/Moscow`). Изменение проходит теми же слоями, что `preferredCheckinsPerDay`:

- `src/domain/employee.ts` — поле в `UserProfile`.
- `src/contracts/minutka-api.ts` — `userProfileSchema`, `completeOnboardingRequestSchema` (валидация — непустая строка; проверка «известная IANA-зона» через `Intl.supportedValuesOf('timeZone')` либо попытку `DateTime.setZone(...).isValid` из luxon).
- `src/application/onboarding-types.ts` — `OnboardingField` расширяется `"timezone"`, `OnboardingDraft`/`OnboardingProfilePatch`/`OnboardingSummary` — поле.
- `src/application/minutka-service.ts` — `completeOnboardingProfile`, `trackedProfileFields`, конечный вопрос онбординга.
- `src/application/onboarding-profile-extractor.ts` (+ Mastra-реализация) — извлечение таймзоны из естественного ответа; при неоднозначности — `needs_choice`/`needs_answer` с подсказкой (город → зона).
- `src/application/runtime-projections/*` — `timezone` в profile-проекции (agent-facing; не PII).
- Postgres: миграция `ALTER TABLE minutka_private.profiles ADD COLUMN timezone text`; для существующих строк — дефолт (например `Europe/Moscow`) с последующим уточнением у сотрудника; `postgres-profile-store.ts` — колонка в SELECT/UPSERT.

> **Почему в профиле, а не в механизме запуска.** И Mastra, и `pg_cron` поддерживают таймзону, но там она описывает *механизм*, а не продуктовую модель сотрудника. Локальное время сотрудника — доменный факт, живущий рядом с ролью и привычками.

### 4.2 Модель правила и расчёт следующего запуска

Правило — декларативная zod-схема, **не cron и не RRULE**:

```ts
export const ScheduleRule = z.object({
  weekdays: z.array(z.number().int().min(1).max(7)).nonempty(), // 1=Пн .. 7=Вс; будни = [1..5]
  time: z.object({
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
  }),
  intervalWeeks: z.number().int().min(1).default(1),  // 2 = «каждый второй»
  anchorDate: z.string().date().optional(),           // опорная дата при intervalWeeks > 1
  catchUpWindowMinutes: z.number().int().min(0).default(120),
});
export type ScheduleRule = z.infer<typeof ScheduleRule>;
```

Чистая функция, принимающая время явно (инъекция `Clock` сохраняется; тестируется без реального времени):

```ts
import { DateTime } from "luxon";

export function computeNextRun(rule: ScheduleRule, timezone: string, after: DateTime): DateTime {
  let cand = after.setZone(timezone)
    .set({ hour: rule.time.hour, minute: rule.time.minute, second: 0, millisecond: 0 });
  for (let i = 0; i < 400; i++) {
    if (cand > after && rule.weekdays.includes(cand.weekday) && matchesInterval(rule, timezone, cand)) {
      return cand.toUTC();
    }
    cand = cand.plus({ days: 1 })
      .set({ hour: rule.time.hour, minute: rule.time.minute, second: 0, millisecond: 0 });
  }
  throw new Error("no occurrence within horizon");
}

function matchesInterval(rule: ScheduleRule, timezone: string, cand: DateTime): boolean {
  if (rule.intervalWeeks <= 1) return true;
  const anchor = DateTime.fromISO(rule.anchorDate!, { zone: timezone }).startOf("week");
  const weeks = Math.floor(cand.startOf("week").diff(anchor, "weeks").weeks);
  return weeks >= 0 && weeks % rule.intervalWeeks === 0;
}
```

**Почему не cron-строки.** POSIX-cron не выражает «каждый второй понедельник» (поле дня недели повторяется еженедельно), а при непустых полях day-of-month И day-of-week парсеры (croner/Vixie) срабатывают по ИЛИ, а не по И — известная ловушка, которую приходится документировать отдельно. Встроенный `computeNextFireAt` из `@mastra/core` доступен и работает с IANA-зонами, но он cron-based и по этой же причине не подходит как авторитетный расчёт.

**Почему не RRULE.** `rrule.js` несёт известные таймзонные баги и решает более общий класс задач (весь iCalendar), чем нам нужен. Декларативная структура тривиально валидируется zod, редактируется формой и покрывается табличными тестами.

**Почему luxon, а не голый `Date` или Temporal-polyfill.** Конверсия wall-clock («19:00 в Europe/Moscow») → UTC через границу перехода на летнее время на голом `Date`/`Intl` ошибкоопасна. Luxon: несуществующее локальное время (весенний скачок) сдвигает вперёд, неоднозначное (осенний повтор) маппит в первое вхождение. Поскольку храним UTC-момент и следующий запуск считаем строго `> after`, двойного срабатывания на осеннем переводе не бывает по построению. Одна зависимость против cron-строк и против веса Temporal-полифилла.

### 4.3 Данные и стор

```sql
-- migrations/00NN_create_process_schedules.sql
CREATE TABLE minutka_private.process_schedules (
  id           uuid PRIMARY KEY,
  employee_id  text NOT NULL REFERENCES minutka_private.participants(employee_id) ON DELETE CASCADE,
  process_id   text NOT NULL,                    -- 'evening_reflection' | 'morning_brief'
  rule         jsonb NOT NULL,                   -- ScheduleRule
  timezone     text NOT NULL,                    -- копия из профиля на момент создания
  enabled      boolean NOT NULL DEFAULT true,
  next_fire_at timestamptz NOT NULL,             -- материализованный UTC-момент
  last_fire_at timestamptz,
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  UNIQUE (employee_id, process_id)
);
CREATE INDEX process_schedules_due_idx
  ON minutka_private.process_schedules (next_fire_at) WHERE enabled;

CREATE TABLE minutka_private.schedule_fires (
  id            uuid PRIMARY KEY,
  schedule_id   uuid NOT NULL REFERENCES minutka_private.process_schedules(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  status        text NOT NULL,                   -- dispatched | late | skipped | failed
  created_at    timestamptz NOT NULL,
  UNIQUE (schedule_id, scheduled_for)            -- идемпотентность как инвариант БД
);
```

Гранты `minutka_runtime` — отдельной миграцией по образцу `0009` (ALTER DEFAULT PRIVILEGES уже покрывает будущие таблицы схемы; проверить, что новые таблицы получают `SELECT, INSERT, UPDATE, DELETE`).

Claim одной транзакцией на **одном** `client` из пула (через `pool.query` `FOR UPDATE` бессмыслен — каждый вызов может уйти в другое соединение):

```sql
BEGIN;
SELECT id, employee_id, process_id, rule, timezone, next_fire_at AS scheduled_for
  FROM minutka_private.process_schedules
 WHERE enabled AND next_fire_at <= now()
 ORDER BY next_fire_at
 FOR UPDATE SKIP LOCKED;
-- на каждую строку: INSERT schedule_fires ... ON CONFLICT DO NOTHING;
-- пересчёт: UPDATE ... SET next_fire_at = computeNextRun(...), last_fire_at = now();
COMMIT;
```

### 4.4 Use-case: запуск процесса без входящего текста

`chat()` не переиспользуется напрямую: он завязан на текст пользователя и на LLM-роутер, выбирающий процесс по этому тексту. У scheduled-запуска текста нет, а процесс уже выбран расписанием. Новый метод:

```ts
runScheduledProcess(input: {
  employeeId: string;
  processId: "evening_reflection" | "morning_brief";
  occurrenceKey: string;   // `schedule:<scheduleId>:<scheduledForIso>` — для аудита/идемпотентности
}): Promise<{ messageId: string; response: string; delivery: DeliveryIntent }>
```

Инварианты:

1. **Guard.** Участник дошёл до `profile_completed` и дал согласие — иначе тихо `skipped` (продукт требует молчания, а не нытья).
2. **Детерминированный форс процессов** `[core, processId]`, минуя LLM-роутер — дешевле и предсказуемее.
3. **Формирование касания.** `evening_reflection` — статический шаблон из брифа («Расскажи день. [🎙 Записать] [📝 Текстом] [⏰ Позже]»), 0 токенов. `morning_brief` — LLM-ход, т.к. касание ссылается на вчерашний контекст (`ConversationStore` + профиль).
4. **Запись ассистентского хода в `ConversationStore`.** Критично: без этого ответ сотрудника вечером не подхватит утренний план, и развалится `SPEC-CONTEXT-001` (утро → вечер).
5. **Audit** `scheduled_process_fired` с `trigger_source: "schedule"`, `processId`, `occurrenceKey` (без PII).
6. Возвращает `DeliveryIntent { employeeId, text, buttons }` — резолв в `chatId` и отправка живут в telegram-слое.

Новый `AgentManualPurpose` (например `scheduled_touch`) и включение `morning_brief` в `DecisionProcessId` / `agentManualProcessIds` / `contracts`.

### 4.5 Telegram-граница: доставка и «писать первым»

Бот вправе написать первым любому, кто **когда-либо** сам запустил с ним диалог. Активация, согласие и онбординг прошли внутри бота — значит, для каждого `profile_completed`-сотрудника это условие выполнено.

- **Обратный маппинг.** `telegram_sessions` пересобирается так, чтобы `employeeId → chatId` был доступен: сырой `chat_id` хранится в приватной схеме (гранты уже ограничены) рядом с существующим `chat_id_digest` (дайджест остаётся для входящего поиска). Опционально — AES-256-GCM под ключом из `postgres-config.ts` (рядом с существующими pepper'ами), что даёт crypto-shredding при удалении данных почти бесплатно. Сырой идентификатор по-прежнему не попадает в проекции, audit и LLM-контекст.
- **Порт** `MessageSender` в telegram-слое принимает `DeliveryIntent`, резолвит `chatId`, шлёт первое касание с inline-кнопками через существующий `replyPort`/Telegraf.
- **Ошибки.** `403 Forbidden` (бот заблокирован) → выключить расписания сотрудника (`enabled = false`), иначе вечный шум ошибок. `429` → сон `retry_after` + один повтор. Джиттер/размазывание отправок — только если сотни расписаний сойдутся в один слот (на ~100 пользователях лимиты недостижимы).

### 4.6 Диспетчер

`schedule-dispatcher` — in-process тик в `serve.ts`, по образцу `draftCleanup` в `create-postgres-runtime.ts`:

```text
setInterval(45s) → если не идёт предыдущий → tick():
  claimDue() (транзакция §4.3)
  для каждого слота:
    late = now - scheduled_for
    если late > catchUpWindowMinutes → status=skipped, continue   # рефлексия в 2 ночи не нужна
    иначе → runScheduledProcess(...) → MessageSender.send(...)     # status=dispatched|late
```

Корректность:

- **2 инстанса.** Пока транзакция A держит строки, `SKIP LOCKED` инстанса B их пропускает; после COMMIT `next_fire_at` уже в будущем — B их не видит. Один слот — один запуск, без leader election.
- **Рестарт.** `next_fire_at` в Postgres переживает рестарт; просроченные — по catch-up policy.
- **Порядок «сдвинуть → COMMIT → выполнить» = at-most-once.** Падение между COMMIT и отправкой теряет слот до следующего, но не дублирует.
- **Graceful shutdown.** `clearInterval` + дождаться текущей итерации; Telegraf останавливается **после** диспетчера, чтобы хвост отправок ушёл. `unref()` — чтобы тик не держал процесс.
- **Точность** — ±интервал тика; для «в 19:00» неотличимо от точного.

### 4.7 Mastra — исполнитель, не планировщик

Встроенный `mastra.schedules` (доступен в `@mastra/core@1.50`, `@mastra/pg` реализует хранилище) **не берём как источник истины**: (1) фича помечена beta; (2) он не выражает per-user правила и `intervalWeeks`; (3) его штатный запуск агента прошёл бы мимо consent-гейта, выбора vault-процесса, `ConversationStore` и audit — всей бизнес-логики, которая живёт в `MinutkaService`; (4) слой `notifications` Mastra тред-центричен и не даёт транспорта в Telegram. Mastra остаётся исполнителем LLM-хода внутри `runScheduledProcess` (утренний бриф); триггер и учёт времени — снаружи.

---

## 5. Тесты (`SPEC-SCHEDULE-001`)

- **Чистая функция** `computeNextRun` — vitest без времени, табличные кейсы: будни 19:00; «каждый второй понедельник» через границу года (anchor); весенний скачок (несуществующее время сдвигается вперёд); осенний повтор (одно срабатывание, без дубля).
- **Тик + claim** — на Postgres (persistence-spec harness): созревший слот → `schedule_fires` создан один раз, `next_fire_at` сдвинут; повторный тик того же момента → `ON CONFLICT DO NOTHING`, второго fire нет.
- **Двойной инстанс** — два параллельных `claimDue` в одном тесте → ассерт: ровно один запуск на слот.
- **Catch-up** — слот старше окна → `skipped` + пересчёт; в пределах окна → `late` + доставка.
- **Guard** — участник без consent/`profile_completed` → тихий `skipped`, `ConversationStore` не тронут.
- **Continuity** — scheduled `morning_brief` пишет ход в `ConversationStore`; последующий `chat()` сотрудника видит его в recent turns (совместимость с `SPEC-CONTEXT-001`).
- **Доставка** — fake `MessageSender`: `403` выключает расписания; предыдущие specs зелёные.

---

## 6. Порядок работ

1. `timezone` в профиле/онбординге + миграция профиля (разблокирует расчёт локального времени).
2. `luxon` + `ScheduleRule` + `computeNextRun` + табличные тесты (чистое ядро без БД).
3. Пересборка `telegram_sessions` под обратный `chatId` + порт `MessageSender`.
4. Миграции `process_schedules` / `schedule_fires` + гранты + `ScheduleStore`.
5. `runScheduledProcess` + новый purpose + vault `morning_brief` + `evening_reflection` scheduled.
6. `schedule-dispatcher` в `serve.ts` (тик, claim, catch-up, shutdown).
7. `SPEC-SCHEDULE-001` + ручной smoke + тег.

Шаги 1–2 самостоятельны и не трогают доставку; 3 — единственное privacy-затрагивающее изменение (пересборка таблицы сессий); 4–6 — механика; 7 дёшев, т.к. `Clock` уже инжектится.

---

## 7. Этапы зрелости (после DoD)

- **Наблюдаемость и ретраи.** `consecutive_errors` + backoff-лестница (30с/60с/5м/15м/60м) на расписание; алерт админу после N ошибок подряд; таймаут-watchdog на вызов use-case (`Promise.race`).
- **Settings-экран.** «⚙️ Настройки — время трёх касаний»: правило редактируется формой поверх `ScheduleRule`.
- **Snooze «⏰ Позже» и «пропустил два дня».** Одноразовый отложенный `schedule_fire`; мягкое напоминание после двух пропусков (продуктовые формулировки).
- **Вынос планировщика в отдельный процесс.** Тот же claim-код за service-эндпоинтом `POST /v1/service/schedules/tick`, дёргаемым внешним метрономом (systemd timer / k8s CronJob / один общий Supabase-cron) через `ServiceMinutkaClient`.
- **Расписания через агента.** Tool Mastra-агента вызывает тот же upsert, что и админка (правило валидируется zod). Обязательный гард: в контексте scheduled-запуска инструменты управления расписаниями отключены — иначе процесс размножит сам себя.
- **Порог смены архитектуры.** Появились процессы, требующие at-least-once с персистентными ретраями/DLQ/приоритетами → graphile-worker или pg-boss поверх того же Postgres; `ScheduleRule` и `computeNextRun` переиспользуются, меняется только исполнитель за claim-циклом.

---

## 8. Обоснование и внешние подтверждения

Дизайн «планировщик как транспорт-адаптер поверх одной таблицы + тик + `SKIP LOCKED`» — не изобретение под этот проект, а индустриальный паттерн для данного класса задач. Два флагманских open-source агента решают ровно эту задачу так же:

- **OpenClaw** — cron-цикл внутри Gateway-процесса + персистентное состояние; просроченные isolated-задачи при старте переносятся на следующий слот, а не проигрываются (прецедент нашей catch-up policy); top-of-hour автоматически размазывается против thundering herd; разделяет `cron` (точное время) и `heartbeat` (ambient-мониторинг) — для «в 19:00» рекомендуется cron, не heartbeat.
- **Hermes Agent** (Nous Research) — тик 60с + `jobs.json` + файловый лок против перекрытия; `wakeAgent`-гейт (детерминированные проверки до пробуждения LLM — наш аналог: guards до обращения к Mastra); запрет рекурсии cron-инструментов; fail-closed при смене модели.

Оба однопроцессные; их взаимоисключение (файловый лок) обобщается на N инстансов заменой на `FOR UPDATE SKIP LOCKED` — без единой новой сущности. Supabase Cron и tinbase подтверждают ту же границу: cron — не бизнес-процесс, а метроном, вызывающий уже существующий исполняемый путь; tinbase при этом сам помечен `alpha / not production-ready`, матчит расписания в UTC и не догоняет пропущенные запуски — как reference-design полезен, как основа для прода — нет.
