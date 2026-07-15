# Фаза B: Банк идей — «ничего не терять» (slim)

> **Родительские документы:** [rfc-personal-assistant-architecture.md](../architecture/rfc-personal-assistant-architecture.md) (§6, §7, §9, §13 фаза B) + [rfc-agent-led-routing.md](../architecture/rfc-agent-led-routing.md) (агент-ведомый роутинг — основной для этой фазы)
> **Предыдущая фаза:** Фаза A — каркас личного vault (коммит `500cc65`)
> **Предусловия:** нет. Заход [fix-routing-catalog.md](./fix-routing-catalog.md) (F1–F8) **superseded** новым RFC; F2 больше не требуется — capture-путь не использует пре-флайт-роутер.
> **Продукт:** персональный ассистент (`AssistantService`, single-owner, `userId`)
> **Целевой результат RFC:** «любое входящее классифицировано и сохранено»

---

## 0. Что изменилось против первой редакции плана

Первая редакция вводила отдельный агент-классификатор (`InboxClassifierRunner`), use-case `captureInbox`, детерминированный форс навыка и предусловие F2. По [rfc-agent-led-routing.md](../architecture/rfc-agent-led-routing.md) это схлопывается:

- **агент сам классифицирует в своём ходу** и зовёт **один typed-инструмент** `captureIdea`, хендлер которого = use-case записи;
- отдельного агента-классификатора, пре-флайт-роутера и форса **нет**;
- **предусловие F2 снято** — без пре-флайт-роутера хардкод-каталог id ни на что не влияет.

Заработанное сохраняется: запись только через use-case (агент не пишет в store напрямую), изоляция по `userId`, тестируемость без LLM, allow-list — теперь на уровне схемы инструмента.

---

## 1. Цель фазы

Пользователь бросает ассистенту что угодно — текст, голос, ссылку, пересланное, фото чека — и это **не теряется**: ассистент определяет суть, классифицирует по двум осям (проект × тип), сохраняет и коротко подтверждает, предлагая следующий шаг. Первая ощутимая ценность пилота поверх Фазы A.

Ключевые архитектурные решения фазы:

- **Агент не пишет в stores.** Агент классифицирует сам и вызывает typed-инструмент `captureIdea`; фактическую запись в `IdeaStore` делает хендлер = use-case в `IngestionService`. Инвариант RFC §6.4 / §7 соблюдён: единственный писатель record-store — use-case, инструмент — контролируемая граница.
- **Классификатор — сквозной доменный тип** `Classified` (§6.1), переиспользуется в Фазах C (задачи) и G (инсайты); вводим один раз в domain.
- **`БЕЗ_ПРОЕКТА` — не молчаливый дефолт, а сигнал спросить.** Если проект не определён — запись всё равно сохраняется (ничего не теряем) с `project: "БЕЗ_ПРОЕКТА"` и обязательным уточняющим вопросом в ответе.
- **«Ничего не терять» — детерминированный инвариант, не надежда на агента.** Capture-путь гарантирует ≥1 сохранённую `Idea`: либо классифицированную вызовом `captureIdea`, либо backstop-запись `БЕЗ_ПРОЕКТА` + `knowledge`, если ход агента завершился без вызова инструмента (ошибка/пропуск). Backstop — несколько строк детерминированного кода, не роутер.
- **Тестируемость без LLM — инвариант.** `IdeaStore` — порт с in-memory адаптером; `AssistantAgentRunner` инжектируется (в specs — mock, который зовёт `captureIdea`). Реальный PostgreSQL — последним шагом за уже проверенным портом.

---

## 2. Definition of Done

- [ ] Доменный тип `Classified` (`ProjectCode`, `RecordType`) + zod-схема в contracts; `БЕЗ_ПРОЕКТА` — константа-сентинел.
- [ ] Порт `IdeaStore` (`add` / `list` / `stale` / `update`) + `InMemoryIdeaStore` с owner-изоляцией по `userId`.
- [ ] Навык `inbox_capture` в `vault/assistant/processes/` по контракту `process-authoring.md`; запись в `registry.json`. Это process-файл, который **агент читает** (описывает, как классифицировать и что подтверждать), а не вход пре-флайт-роутера.
- [ ] Typed-инструмент `captureIdea` (Mastra tool) со схемой `{ project, type, summary, suggestedNextStep, needsProjectClarification }`; хендлер = use-case `IngestionService.captureIdea`. Схема — единственная точка allow-list (тип `RecordType` — `z.enum`; неизвестный `project` схлопывается в `БЕЗ_ПРОЕКТА` в хендлере).
- [ ] Use-case `IngestionService.captureIdea({ userId, source, classification })`: запись `Idea` в `IdeaStore` → короткое подтверждение + следующий шаг; для `БЕЗ_ПРОЕКТА` — уточняющий вопрос. Единственный писатель record-store.
- [ ] Backstop «не терять»: `AssistantService` на capture-пути гарантирует ≥1 запись — если ход агента не вызвал `captureIdea`, сохраняет сырой ввод как `БЕЗ_ПРОЕКТА` + `knowledge` и просит уточнить.
- [ ] `AssistantService` даёт агенту инструмент `captureIdea` на capture-пути; `IdeaStore` агенту напрямую не доступен. `toolChoice` скоупится: `captureIdea` (внутренняя обратимая запись владельца, RFC §9 «автоматически в личном контуре») разрешён; внешних действий у навыка нет.
- [ ] Проекция `/proc/records` наполняется реальными идеями через bounded read-model (лимиты по числу и символам, как в `assistant-context-projection.ts`).
- [ ] Ветвление входящих каналов из Telegram: голос → STT → текстовый путь; фото/ссылка/пересланное → блоб в `BlobStore` (`inbox/*`, путь Фазы A) + `Idea.source` = ключ блоба. Файл → capture-путь детерминированным гейтом входа (не LLM-роутер).
- [ ] PostgreSQL-адаптер `IdeaStore` + миграция `0011_create_ideas.sql` + гранты `minutka_runtime` (по образцу `0009`); owner-constraint по `userId`.
- [ ] `SPEC-PERSONAL-ASSISTANT-INBOX-001` через mock-runner: текст → `captureIdea` вызван → идея классифицирована и сохранена; `БЕЗ_ПРОЕКТА` → уточняющий вопрос; чужой `userId` не виден; ход без вызова инструмента → backstop-запись без потери.
- [ ] Persistence-spec: контракт `IdeaStore` (тот же, что у in-memory) на реальном PostgreSQL; `stale(days)` и фильтр по `Classified`.
- [ ] Предыдущие specs (включая `SPEC-PERSONAL-ASSISTANT-PHASE-A-001`) остаются зелёными.
- [ ] `npm run typecheck`, `npm run specs`, `npm run verify`, `npm run verify:persistence` проходят.
- [ ] Ручной smoke: голос/фото/ссылка/текст из Telegram → запись в банке идей с корректной классификацией и подтверждением.
- [ ] Коммиты по шагам B1–B5 (см. §6).

---

## 3. Границы фазы

### Входит

1. Сквозной классификатор `Classified` в domain + contracts (§4.1).
2. Порт `IdeaStore` + in-memory адаптер (§4.2).
3. Навык `inbox_capture` (process-файл, читаемый агентом) + typed-инструмент `captureIdea` (§4.3).
4. Use-case `captureIdea` + backstop и подключение в `AssistantService` (§4.4).
5. Проекция `/proc/records` над `IdeaStore` (§4.5).
6. Приём мультимедиа из Telegram (голос/фото/ссылка/пересланное) через ingestion (§4.6).
7. PostgreSQL-адаптер `IdeaStore` + миграция + гранты (§4.7).
8. `SPEC-PERSONAL-ASSISTANT-INBOX-001` и ручной smoke.

### Не входит (сознательно)

- **`TaskStore` и `ExpenseStore`.** Задачи — Фаза C, расходы — позже на том же паттерне. B доказывает паттерн на **одном** record-store (`Idea`).
- **Пре-флайт-LLM-роутер выбора навыков.** По `rfc-agent-led-routing.md` не вводится, пока навыков единицы; возврат — только при много-навыковом мисс-роутинге (RFC §11).
- **Извлечение задач/встреч/расходов из того же входящего.** `inbox_capture` кладёт всё как `Idea`. Ветвление «это задача / это чек» — Фазы C+; `RecordType` уже несёт `money`, модель не переписывается.
- **Векторный/полнотекстовый поиск.** RFC §14.2: отложено; `stale(days)` и фильтр по `Classified` покрывают запросы фазы.
- **UI/команды управления банком** — Фазы G и D. `stale()` вводим сейчас как API стора, продуктовый навык поверх — позже.
- **MinIO object versioning для записей.** Идеи живут в PostgreSQL; версионируются только документы-контекст (Фаза A).

---

## 4. Архитектурное решение

### 4.1 Сквозной классификатор (domain + contracts)

Новый файл `src/domain/classification.ts` — две оси из RFC §6.1:

```ts
// Ось 1: проект. Расширяемый список кодов; конкретные коды пользователя
// живут в его context/06_классификатор.md, здесь — только тип и сентинел.
export type ProjectCode = string;                 // "АССИСТЕНТ" | "БНВ" | ...
export const NO_PROJECT: ProjectCode = "БЕЗ_ПРОЕКТА";

// Ось 2: тип действия по сути.
export type RecordType =
  | "money" | "development" | "content"
  | "people" | "operations" | "knowledge" | "personal";

export type Classified = { project: ProjectCode; type: RecordType };
```

В `src/contracts/` — zod-схема `classifiedSchema` (`recordType` как `z.enum`, `project` как непустая строка). Валидация «известный проект» **не** в contracts: список проектов — пользовательские данные из vault; неизвестный проект схлопывается в `NO_PROJECT` в хендлере инструмента (§4.4), а не отвергается.

> **Почему `project` — строка, а не enum.** Проекты у каждого владельца свои и меняются (RFC §6.1). Жёсткий enum требовал бы миграции кода на каждый новый проект. Единственный код-инвариант — сентинел `NO_PROJECT` («спросить»).

### 4.2 Порт `IdeaStore` + in-memory адаптер

`src/application/idea-store.ts` — по образцу существующих портов (`document-store.ts`, `conversation-store.ts`), с явным `userId` как границей изоляции:

```ts
import type { Classified } from "../domain/classification.js";

export type Idea = Classified & {
  id: string;
  userId: string;
  summary: string;                 // суть одной строкой
  source?: string;                 // ключ блоба в BlobStore, если входящее — файл/фото
  status: "raw" | "discussed" | "planned" | "done" | "dropped";
  createdAt: string;
  lastActivityAt: string;
};

export type IdeaStore = {
  add(idea: Omit<Idea, "id" | "createdAt" | "lastActivityAt">): Promise<Idea>;
  list(userId: string, filter?: Partial<Classified> & { status?: Idea["status"] }): Promise<Idea[]>;
  stale(userId: string, days: number): Promise<Idea[]>;   // без движения ≥ N дней
  update(userId: string, id: string, patch: Partial<Idea>): Promise<Idea>;
};
```

`src/application/in-memory-idea-store.ts` — hermetic-адаптер для specs (по образцу `in-memory-document-store.ts`): `Map`, `Clock` для `createdAt`/`lastActivityAt`, фильтрация строго по `userId`, `stale` относительно `clock.now()`. `assertUserId` переиспользуется из `document-store.ts`.

### 4.3 Навык `inbox_capture` + typed-инструмент `captureIdea`

**Vault-файл** `vault/assistant/processes/inbox_capture.md` по контракту `process-authoring.md` (`When applies / Inputs / Process / Outputs / Privacy notes / Anti-patterns / Dependencies`). Это **инструкция для агента**, который читает её в своём ходу: определить тип входящего → предложить категорию (проект × тип) → вызвать `captureIdea` → подтвердить коротко → предложить следующий шаг. Anti-patterns: не выдумывать проект (при неуверенности — `БЕЗ_ПРОЕКТА` + вопрос, `needsProjectClarification: true`); не выполнять внешние действия (покупки/брони только предлагаются, RFC §7).

**Запись в `registry.json`** (каталог навыков; для агент-ведомой модели — источник индекса, читаемого агентом, а не вход пре-флайт-роутера):

```json
{
  "id": "inbox_capture",
  "path": "vault/assistant/processes/inbox_capture.md",
  "appliesTo": ["chat", "file_uploaded"],
  "dependencies": ["docs/architecture/rfc-personal-assistant-architecture.md#7-ingestion-три-канала-одна-точка-записи"]
}
```

**Typed-инструмент** `src/mastra/tools/capture-idea-tool.ts` — контролируемая граница записи. Схема (zod) — единственная точка allow-list:

```ts
export const captureIdeaInput = z.object({
  project: z.string().min(1),                 // ProjectCode; неизвестный → NO_PROJECT в хендлере
  type: recordTypeEnum,                        // z.enum(RecordType) — LLM не выдумает тип
  summary: z.string().min(1),                  // суть одной строкой
  suggestedNextStep: z.string().min(1),        // короткий следующий шаг
  needsProjectClarification: z.boolean(),      // true ⇒ ответ содержит уточняющий вопрос
});
```

Хендлер инструмента вызывает `IngestionService.captureIdea` (§4.4) — то есть агент через инструмент инициирует запись, но сам в store не пишет. Инструмент доступен агенту на capture-пути; `toolChoice` разрешает его (внутренняя обратимая запись владельца, RFC §9), внешних действий у навыка нет.

### 4.4 Use-case: `captureIdea` + backstop

`IngestionService` (Фаза A — единственная точка записи) получает метод:

```ts
captureIdea(input: {
  userId: string;
  source: { text: string } | { blobKey: string; caption?: string };
  classification: {
    project: ProjectCode; type: RecordType;
    summary: string; suggestedNextStep: string; needsProjectClarification: boolean;
  };
}): Promise<{ idea: Idea; reply: string }>
```

Инварианты:

1. **Нормализация проекта.** Если `project` не входит в список проектов владельца (читается из `context/06_классификатор.md` через `DocumentStore`, best-effort) — схлопнуть в `NO_PROJECT` и выставить `needsProjectClarification`.
2. **Запись** через `IdeaStore.add` со `status: "raw"`, `source = blobKey` при файловом входящем. Единственный писатель record-store.
3. **Ответ.** Короткое подтверждение («Записал в идеи: <summary> · <проект>/<тип>. Следующий шаг: <...>»); при `needsProjectClarification` — добавить вопрос про проект. Никаких внешних действий.
4. **Audit.** Событие `inbox_captured` (`userId`, `ideaId`, `project`, `type`, `source: text|blob`) — без сырого текста/PII в нагрузке.

**Backstop «не терять»** — в `AssistantService`, не в use-case: capture-путь запускает ход агента с доступным `captureIdea`; если ход завершился **без** вызова инструмента (ошибка модели/пропуск), `AssistantService` сам зовёт `IngestionService.captureIdea` с фолбэк-классификацией (`project: NO_PROJECT`, `type: "knowledge"`, `summary` = усечённый исходный текст, `needsProjectClarification: true`). «Ничего не терять» сильнее «идеально классифицировать». Backstop детерминирован и покрыт spec.

`AssistantService` на capture-пути даёт агенту инструмент и, при отсутствии его вызова, включает backstop. Разделение «capture vs обычный диалог» на этой фазе — детерминированный гейт входа: наличие файла ⇒ capture; для текста на MVP весь `chat` идёт в банк идей (других навыков ещё нет). Обобщение — по мере роста каталога, в агент-ведомой модели (агент сам выбирает процесс по индексу).

### 4.5 Проекция `/proc/records`

Новый `src/application/assistant-records-projection.ts` по образцу `assistant-context-projection.ts`: bounded read-model над `IdeaStore.list` (последние N идей, лимит по числу и символам, `truncated`-флаг), рендер с фенсингом как данных, не инструкций. Подключается в `AssistantService` рядом с `/proc/context`, чтобы агент видел недавние записи владельца. Строится только для аутентифицированного `userId` (изоляция §11 RFC).

### 4.6 Telegram-граница: приём мультимедиа

Каналы наполнения из RFC §7, все — через `IngestionService`:

- **Голос** → существующий STT (`phase-5-voice-stt`) → транскрипт как `source.text` → capture-путь.
- **Фото (чек/скрин)** → `uploadInboxBlob` (Фаза A, `inbox/*`) → capture-путь с `source: { blobKey, caption }`; `Idea.source` = ключ блоба.
- **Ссылка / пересланное / текст** → capture-путь с `source: { text }`.

Триггер `file_uploaded` — детерминированный гейт входа (файл ⇒ capture-путь), не LLM-роутер. Разрешение `userId → chatId` и отправка ответа — существующим telegram-слоем.

### 4.7 PostgreSQL-адаптер и миграция

`migrations/0011_create_ideas.sql` (следующий после `0010`), схема `minutka_private` (переиспользуем — это физическая схема хранилища):

```sql
CREATE TABLE minutka_private.ideas (
  id                uuid PRIMARY KEY,
  user_id           text NOT NULL,
  project           text NOT NULL,        -- ProjectCode, включая 'БЕЗ_ПРОЕКТА'
  type              text NOT NULL,        -- RecordType
  summary           text NOT NULL,
  source            text,                 -- ключ блоба в BlobStore
  status            text NOT NULL,        -- raw|discussed|planned|done|dropped
  created_at        timestamptz NOT NULL,
  last_activity_at  timestamptz NOT NULL
);
CREATE INDEX ideas_owner_activity_idx ON minutka_private.ideas (user_id, last_activity_at);
CREATE INDEX ideas_owner_status_idx   ON minutka_private.ideas (user_id, status);
```

- Гранты `minutka_runtime` — по образцу `0009` (`SELECT, INSERT, UPDATE, DELETE`); проверить, что `ALTER DEFAULT PRIVILEGES` покрывает новую таблицу.
- `src/infrastructure/postgres/postgres-idea-store.ts` — реализация порта по образцу `postgres-insight-store.ts` (zod-парс строки, `mapPostgresError`, `withTransaction` для `add`/`update`). **Owner-constraint**: каждый запрос фильтрует по `user_id`.
- `stale(userId, days)`: `WHERE user_id = $1 AND last_activity_at < now() - ($2 * interval '1 day') AND status IN ('raw','discussed')`.

> **Почему `minutka_private`, а не новая схема.** RFC §14.1 — один репозиторий/деплой; физические схемы переиспользуются, продуктовые границы задаёт `userId`-изоляция, а не имя схемы.

---

## 5. Тесты (`SPEC-PERSONAL-ASSISTANT-INBOX-001`)

Через in-memory адаптеры и mock-runner (без LLM, без сети), по образцу Phase A spec. Mock-runner имитирует ход агента: на вход X вызывает инструмент `captureIdea` с заданными аргументами (или, для backstop-кейса, не вызывает).

- **Классификация и запись.** Текст → mock-runner зовёт `captureIdea({project:"АССИСТЕНТ", type:"development", ...})` → `IdeaStore` содержит одну идею с этими осями, `status:"raw"`; ответ содержит summary и следующий шаг.
- **`БЕЗ_ПРОЕКТА` ⇒ вопрос.** `captureIdea` с `NO_PROJECT` / `needsProjectClarification:true` → идея сохранена **и** ответ содержит уточняющий вопрос про проект.
- **Backstop без потери.** Ход агента завершился без вызова `captureIdea` → `AssistantService` сохранил идею как `NO_PROJECT` + `knowledge`, ответ просит уточнить; исключение наверх не проброшено.
- **Нормализация неизвестного проекта.** `captureIdea` с проектом, которого нет в `06_классификатор.md` → хендлер схлопнул в `NO_PROJECT` + `needsProjectClarification`.
- **Owner-изоляция.** Идеи `userId=maxim` не видны в `list`/`stale`/проекции для `other-owner`.
- **Файловый вход.** capture-путь с `blobKey` → `Idea.source` = этот ключ; блоб в `inbox/*`.
- **Проекция `/proc/records`.** Bounded: при превышении лимита — `truncated:true`, чужие идеи отсутствуют.

**Persistence-spec** (реальный PostgreSQL, `verify:persistence`): контракт `IdeaStore` идентичен in-memory; отдельно — `stale(days)` на граничных датах и фильтр по `Classified`; owner-constraint (запрос чужого id возвращает пусто).

---

## 6. Порядок работ

Вертикальные срезы; каждый шаг — отдельный коммит, заканчивается зелёными typecheck + specs. B1–B3 дают работающий путь «текст → идея → подтверждение» **без обращения к БД и сети**; реальный PostgreSQL — последним, за уже проверенным портом. **Предусловий-заходов нет** (F2 снят).

1. **B1 — классификатор как тип.** `src/domain/classification.ts` + `classifiedSchema` в contracts. Проверка: unit на схему/сентинел. *Самостоятелен.*
2. **B2 — `IdeaStore` порт + in-memory.** `idea-store.ts` + `in-memory-idea-store.ts`. Проверка: unit на `stale(days)` и фильтр по `Classified`.
3. **B3 — навык + инструмент + use-case + backstop на in-memory.** `inbox_capture.md` + `registry.json`; `capture-idea-tool.ts`; `IngestionService.captureIdea`; backstop и подключение инструмента в `AssistantService`. Проверка: `SPEC-PERSONAL-ASSISTANT-INBOX-001` на mock-runner. **Полностью работающий срез без БД/сети.**
4. **B4 — каналы Telegram + `/proc/records`.** Ветвление голос/фото/ссылка/текст через ingestion; проекция `/proc/records`. Проверка: spec-кейсы на каждый тип входящего + bounded-проекция. *(Опционально дробится по типам входящего.)*
5. **B5 — PostgreSQL за портом.** Миграция `0011` + гранты + `postgres-idea-store.ts`; продакшн-композиция проецирует реальные данные. Проверка: persistence-spec (тот же контракт) + ручной smoke. *Откладываем в конец.*

Порядок разблокировки: B1 → B2 → B3 (ядро ценности) → B4 (каналы) → B5 (durability). Реальный Mastra-агент с инструментом `captureIdea` ставится параллельно B3/B4 (инжектится тот же `AssistantAgentRunner`).

---

## 7. Этапы зрелости (после DoD)

- **Ветвление типов записи.** `inbox_capture` начинает различать `idea` / `task` / `expense` из одного входящего; `TaskStore`/`ExpenseStore` появляются за тем же паттерном (инструмент + use-case) — вход в Фазы C и «финансы».
- **Рост каталога навыков — агент-ведомо.** Когда навыков станет несколько, агент выбирает процесс по индексу сам (core + `index.md` + инструменты). Пре-флайт-роутер возвращается только при наблюдаемом мисс-роутинге (RFC §11, `rfc-agent-led-routing.md` §7).
- **Недельный обзор банка** (Фаза D) и **карта рутины** (Фаза G) поверх `stale()` и `list()` — продуктовые навыки над существующим API стора.
- **Полнотекстовый/векторный поиск.** При росте корпуса — `tsvector`/`pgvector` отдельной миграцией (RFC §14.2), `IdeaStore` расширяется методом поиска, паттерн порта сохраняется.
- **Связь «идея → задача → продажа».** `Task.originIdeaId` (RFC §6.4) сошьёт банк идей с планированием — межстор-запрос в Фазе C.

---

## 8. Соответствие RFC

| Инвариант RFC | Как соблюдён в фазе |
|---|---|
| Агент не пишет в stores напрямую (§6.4, §7) | Агент зовёт `captureIdea`; пишет хендлер = `IngestionService.captureIdea` |
| Единая точка записи (§7) | Все каналы (голос/фото/ссылка/текст) → `IngestionService` |
| Агент-ведомый роутинг (rfc-agent-led-routing) | Агент классифицирует и выбирает действие сам; пре-флайт-роутера и форса нет |
| `БЕЗ_ПРОЕКТА` ⇒ агент обязан спросить (§6.1) | `needsProjectClarification` + уточняющий вопрос в ответе |
| Не выдумывать факты (§4.1) | Неуверенность → `NO_PROJECT` + вопрос, а не выдуманный проект; backstop не теряет ввод |
| Owner-изоляция по `userId` (§5.3, §11) | Фильтр по `userId` во всех методах стора; проекции только для владельца |
| Тестируемость без LLM (§12) | Порт + in-memory; `AssistantAgentRunner` инжектируется (mock зовёт инструмент); specs без сети |
| Внешние действия — только предложение (§7, §9) | Capture-путь ничего не отправляет/не покупает; инструмент — внутренняя обратимая запись владельца |
