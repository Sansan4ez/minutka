# Фаза B: Банк идей — «ничего не терять»

> **Родительский документ:** [rfc-personal-assistant-architecture.md](../architecture/rfc-personal-assistant-architecture.md) (§6, §7, §8, §13 фаза B)
> **Предыдущая фаза:** Фаза A — каркас личного vault (коммит `500cc65`)
> **Продукт:** персональный ассистент (`AssistantService`, single-owner, `userId`), **не** «Минутка»
> **Целевой результат RFC:** «любое входящее классифицировано и сохранено»

---

## 1. Цель фазы

Пользователь бросает ассистенту что угодно — текст, голос, ссылку, пересланное сообщение, фото чека — и это **не теряется**: ассистент определяет суть, классифицирует по двум осям (проект × тип), сохраняет запись и коротко подтверждает, предлагая следующий шаг. Это первая ощутимая ценность пилота поверх фундамента Фазы A.

Ключевые архитектурные решения фазы (все — прямое следствие RFC, не изобретение):

- **Агент не пишет в stores.** Классификатор-навык возвращает application-слою *структурированное предложение* (проект, тип, суть, следующий шаг), а запись в `IdeaStore` делает типизированный use-case через `IngestionService`. Это инвариант RFC §6.4 («все мутации record stores вызываются только из application use-cases, не агентом напрямую») и §7 («агенту не даётся произвольная запись»).
- **Классификатор — сквозной доменный тип**, а не поле идеи. `Classified` (§6.1) переиспользуется в Фазах C (задачи) и B-инсайтах; вводим его один раз в domain.
- **`БЕЗ_ПРОЕКТА` — не молчаливый дефолт, а сигнал спросить.** Если навык не смог отнести входящее к проекту, запись всё равно сохраняется (ничего не теряем), но с `project: "БЕЗ_ПРОЕКТА"` и обязательным уточняющим вопросом в ответе — так «ничего не терять» не конфликтует с «не выдумывать факты» (RFC §4.1).
- **Тестируемость без LLM и без сети — инвариант, а не намерение.** `IdeaStore` вводится как порт с in-memory адаптером; классификатор инжектируется как функция (mock в specs, Mastra в проде). Реальный PostgreSQL появляется последним шагом за уже проверенным портом.

---

## 2. Definition of Done

- [ ] Доменный тип `Classified` (`ProjectCode`, `RecordType`) + zod-схема в contracts; `БЕЗ_ПРОЕКТА` — константа-сентинел.
- [ ] Порт `IdeaStore` (`add` / `list` / `stale` / `update`) + `InMemoryIdeaStore` с owner-изоляцией по `userId`.
- [ ] Навык `inbox_capture` в `vault/assistant/processes/` по контракту `process-authoring.md`; запись в `registry.json` с `appliesTo: ["chat", "file_uploaded"]`.
- [ ] Контракт классификатора-навыка `InboxClassification` (zod): `{ kind: "idea", project, type, summary, suggestedNextStep, needsProjectClarification }`; невалидный ответ LLM → безопасный фолбэк (сохранить как `БЕЗ_ПРОЕКТА`, спросить), а не потеря входящего.
- [ ] Use-case `IngestionService.captureInbox({ userId, source, blobKey? })`: прогон через классификатор → запись `Idea` в `IdeaStore` → короткое подтверждение + следующий шаг; для `БЕЗ_ПРОЕКТА` — уточняющий вопрос.
- [ ] `AssistantService` инициирует capture-путь для `chat` и `file_uploaded`; агент не получает доступа к `IdeaStore`.
- [ ] Проекция `/proc/records` наполняется реальными идеями через bounded read-model (лимиты по числу и символам, как в `assistant-context-projection.ts`).
- [ ] Ветвление входящих каналов из Telegram: голос → STT → текстовый путь; фото/ссылка/пересланное → блоб в `BlobStore` (`inbox/*`, путь Фазы A) + `Idea.source` = ключ блоба.
- [ ] Новый триггер router `file_uploaded` учтён в контрактах/типах (для этой фазы — детерминированный форс `inbox_capture`, без обязательного LLM-роутера).
- [ ] PostgreSQL-адаптер `IdeaStore` + миграция `0011_create_ideas.sql` + гранты `minutka_runtime` (по образцу `0009`); owner-constraint по `userId`.
- [ ] `SPEC-PERSONAL-ASSISTANT-INBOX-001` через mock-классификатор: текст → идея классифицирована и сохранена; `БЕЗ_ПРОЕКТА` → уточняющий вопрос; чужой `userId` не виден; невалидный ответ LLM → фолбэк без потери.
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
3. Навык `inbox_capture` и контракт классификатора-навыка (§4.3).
4. Use-case `captureInbox` и его подключение в `AssistantService` (§4.4).
5. Проекция `/proc/records` над `IdeaStore` (§4.5).
6. Приём мультимедиа из Telegram (голос/фото/ссылка/пересланное) через ingestion (§4.6).
7. PostgreSQL-адаптер `IdeaStore` + миграция + гранты (§4.7).
8. `SPEC-PERSONAL-ASSISTANT-INBOX-001` и ручной smoke.

### Не входит (сознательно)

- **`TaskStore` и `ExpenseStore`.** Модель `Task`/`Expense` описана в RFC §6.4, но задачи — это Фаза C (`day_focus`, календарь), а расходы естественно ложатся на тот же паттерн позже. B доказывает паттерн на **одном** record-store (`Idea`), чтобы не размножать миграции до подтверждения формы.
- **Полноценный LLM-роутер выбора навыков в `AssistantService`.** В Фазе A `chat` вызывает `agentRunner` напрямую. Для B достаточно **детерминированного форса** `inbox_capture` на capture-пути; обобщённый router (RFC §8.2, strict JSON `selectedProcessIds`) вводится, когда навыков станет несколько (Фаза C+). Триггер `file_uploaded` при этом уже фиксируется в типах, чтобы router потом не переписывать.
- **Извлечение задач/встреч/расходов из того же входящего.** `inbox_capture` в этой фазе кладёт всё как `Idea` (сырьё банка идей). Ветвление «это задача / это чек» — Фазы C и далее; `RecordType` уже несёт `money`, так что модель не переписывается.
- **Векторный/полнотекстовый поиск по идеям.** RFC §14.2: отложено; `stale(days)` и фильтр по `Classified` покрывают запросы фазы через обычный индекс.
- **UI/команды управления банком** («покажи идеи без движения») как отдельный навык — это Фаза G (`context_insights`) и недельный обзор (Фаза D). `stale()` вводим сейчас как API стора, продуктовый навык поверх — позже.
- **MinIO object versioning для записей.** Идеи живут в PostgreSQL; версионируются только документы-контекст (Фаза A), не record-store.

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

В `src/contracts/` — zod-схема `classifiedSchema` (`recordType` как `z.enum`, `project` как непустая строка). Валидация «известный проект» **не** делается в contracts: список проектов — пользовательские данные из vault, а не константа кода; неизвестный проект схлопывается в `NO_PROJECT` на уровне use-case (§4.4), а не отвергается.

> **Почему `project` — строка, а не enum.** Проекты у каждого владельца свои и меняются (RFC §6.1: «расширяемый список»). Жёсткий enum потребовал бы миграции кода на каждый новый проект пользователя. Единственный код-инвариант — сентинел `NO_PROJECT`, означающий «спросить».

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

`src/application/in-memory-idea-store.ts` — hermetic-адаптер для specs (по образцу `in-memory-document-store.ts`): `Map`, `Clock` для `createdAt`/`lastActivityAt`, фильтрация строго по `userId`, `stale` считается относительно `clock.now()`. `assertUserId` переиспользуется из `document-store.ts` (уже экспортируется).

### 4.3 Навык `inbox_capture` и контракт классификатора-навыка

**Vault-файл** `vault/assistant/processes/inbox_capture.md` по контракту `process-authoring.md` (`When applies / Inputs / Process / Outputs / Privacy notes / Anti-patterns / Dependencies`). Реализует `бизнес-процесс_входящий_поток` (RFC §7): определить тип → предложить категорию (проект × тип) → сохранить → подтвердить коротко → предложить следующий шаг. Anti-patterns: не выдумывать проект (при неуверенности — `БЕЗ_ПРОЕКТА` + вопрос); не выполнять внешние действия (покупки/брони только предлагаются, RFC §7).

**Запись в `registry.json`:**

```json
{
  "id": "inbox_capture",
  "path": "vault/assistant/processes/inbox_capture.md",
  "appliesTo": ["chat", "file_uploaded"],
  "dependencies": ["docs/architecture/rfc-personal-assistant-architecture.md#7-ingestion-три-канала-одна-точка-записи"]
}
```

**Контракт результата навыка** — агент возвращает не свободный текст, а структуру (валидируется на границе, LLM переспрашивается при mismatch — модель `mastra`-schema):

```ts
export type InboxClassification = {
  kind: "idea";                        // задел под "task" | "expense" в след. фазах
  project: ProjectCode;                // NO_PROJECT, если не уверен
  type: RecordType;
  summary: string;                     // суть одной строкой
  suggestedNextStep: string;           // короткий следующий шаг для подтверждения
  needsProjectClarification: boolean;  // true ⇒ ответ содержит уточняющий вопрос
};
```

Тип runner’а расширяется: помимо текстового `AssistantAgentRunner` (Фаза A) вводится `InboxClassifierRunner = (input) => Promise<InboxClassification>`. В specs — детерминированный mock; в проде — Mastra-агент со structured output (`src/mastra/agents`, tool не нужен — это чистая классификация, без побочных эффектов, `toolChoice: "none"` сохраняется).

### 4.4 Use-case: `captureInbox`

Расширяем `IngestionService` (Фаза A уже сделала его единственной точкой записи) методом:

```ts
captureInbox(input: {
  userId: string;
  source: { text: string } | { blobKey: string; caption?: string };
}): Promise<{ idea: Idea; reply: string }>
```

Инварианты:

1. **Классификация до записи.** Вызвать `InboxClassifierRunner` с текстом (или caption + ссылкой на блоб). Результат валидируется zod; при провале валидации/ошибке — **фолбэк, а не исключение вверх**: `project: NO_PROJECT`, `type: "knowledge"`, `summary` = усечённый исходный текст, `needsProjectClarification: true`. «Ничего не терять» сильнее «идеально классифицировать».
2. **Нормализация проекта.** Если `project` не входит в список проектов владельца (читается из `context/06_классификатор.md` через `DocumentStore`, best-effort) — схлопнуть в `NO_PROJECT` и выставить `needsProjectClarification`.
3. **Запись** через `IdeaStore.add` со `status: "raw"`, `source = blobKey` при файловом входящем. Это единственный писатель record-store; агент сюда доступа не имеет.
4. **Ответ.** Короткое подтверждение («Записал в идеи: <summary> · <проект>/<тип>. Следующий шаг: <...>»); при `needsProjectClarification` — добавить вопрос про проект. Никаких внешних действий.
5. **Audit.** Событие `inbox_captured` (`userId`, `ideaId`, `project`, `type`, `source: text|blob`) — без сырого текста/PII в audit-нагрузке.

`AssistantService` получает `captureInbox` в deps и вызывает его на capture-пути. Для `chat` без файла — по-прежнему возможен обычный ответный путь Фазы A; разделение «это capture vs обычный диалог» на этой фазе — детерминированное (наличие файла ⇒ capture; для текста — на MVP считаем весь `chat` в банк идей, т.к. других навыков ещё нет; обобщение — router Фазы C).

### 4.5 Проекция `/proc/records`

Новый `src/application/assistant-records-projection.ts` по образцу `assistant-context-projection.ts`: bounded read-model над `IdeaStore.list` (последние N идей, лимит по числу и символам, `truncated`-флаг), рендер с фенсингом как данных, не инструкций. Подключается в `AssistantService` рядом с `/proc/context`, чтобы агент видел недавние записи владельца при ответах. Строится только для аутентифицированного `userId` (изоляция §11 RFC).

### 4.6 Telegram-граница: приём мультимедиа

Каналы наполнения из RFC §7, все — через `IngestionService` (агенту произвольная запись не даётся):

- **Голос** → существующий STT (`phase-5-voice-stt` уже в кодовой базе) → транскрипт как `source.text` → тот же `captureInbox`.
- **Фото (чек/скрин)** → `uploadInboxBlob` (Фаза A, `inbox/*`) → `captureInbox({ source: { blobKey, caption } })`; `Idea.source` = ключ блоба.
- **Ссылка / пересланное / текст** → `captureInbox({ source: { text } })`.

Триггер `file_uploaded` (RFC §8.2) фиксируется в типах purpose/триггеров, но на этой фазе он детерминированно форсит `inbox_capture` (не требует LLM-роутера). Разрешение `userId → chatId` и отправка ответа — существующим telegram-слоем.

### 4.7 PostgreSQL-адаптер и миграция

`migrations/0011_create_ideas.sql` (следующий номер после `0010`), схема `minutka_private` (переиспользуем — это физическая схема хранилища, не роль-модель «Минутки»):

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

- Гранты `minutka_runtime` — отдельной миграцией/секцией по образцу `0009` (`SELECT, INSERT, UPDATE, DELETE`); проверить, что `ALTER DEFAULT PRIVILEGES` уже покрывает новую таблицу.
- `src/infrastructure/postgres/postgres-idea-store.ts` — реализация порта по образцу `postgres-insight-store.ts` (zod-парс строки, `mapPostgresError`, `withTransaction` для `add`/`update`). **Owner-constraint**: каждый запрос фильтрует по `user_id`; `update`/`list`/`stale` никогда не выбирают чужие строки (аналог `employeeId`-ownership из `0007`).
- `stale(userId, days)`: `WHERE user_id = $1 AND last_activity_at < now() - ($2 * interval '1 day') AND status IN ('raw','discussed')` (созревшие/без движения; done/dropped исключены).

> **Почему `minutka_private`, а не новая схема.** Решение RFC §14.1 — один репозиторий/деплой; физические схемы переиспользуются, продуктовые границы задаются `userId`-изоляцией и проекциями, а не именем схемы. Отдельная схема — только если позже «Минутка» и ассистент разъедутся в два деплоя.

---

## 5. Тесты (`SPEC-PERSONAL-ASSISTANT-INBOX-001`)

Через in-memory адаптеры и mock-классификатор (без LLM, без сети), по образцу Phase A spec:

- **Классификация и запись.** Текст → mock-классификатор вернул `{project:"АССИСТЕНТ", type:"development", ...}` → `IdeaStore` содержит одну идею с этими осями, `status:"raw"`; ответ содержит summary и следующий шаг.
- **`БЕЗ_ПРОЕКТА` ⇒ вопрос.** Классификатор вернул `NO_PROJECT` / `needsProjectClarification:true` → идея сохранена (не потеряна) **и** ответ содержит уточняющий вопрос про проект.
- **Фолбэк на невалидный ответ LLM.** Классификатор бросил/вернул мусор → идея всё равно сохранена как `NO_PROJECT` + `knowledge`, ответ просит уточнить; исключение наверх не проброшено.
- **Owner-изоляция.** Идеи `userId=maxim` не видны в `list`/`stale`/проекции для `other-owner` (аналог проверки Phase A «чужой секрет»).
- **Файловый вход.** `captureInbox` с `blobKey` → `Idea.source` = этот ключ; блоб лежит в `inbox/*`.
- **Проекция `/proc/records`.** Bounded: при превышении лимита — `truncated:true`, чужие идеи отсутствуют.

**Persistence-spec** (реальный PostgreSQL, harness `verify:persistence`): контракт `IdeaStore` идентичен in-memory; отдельно — `stale(days)` на граничных датах и фильтр по `Classified`; owner-constraint (запрос чужого id возвращает пусто).

---

## 6. Порядок работ

Вертикальные срезы; каждый шаг — отдельный коммит, заканчивается зелёными typecheck + specs. B1–B3 дают работающий путь «текст → идея → подтверждение» **без единого обращения к БД и сети**; реальный PostgreSQL — последним, за уже проверенным портом.

1. **B1 — классификатор как тип.** `src/domain/classification.ts` + `classifiedSchema` в contracts. Проверка: unit на схему/сентинел. *Самостоятелен, ничего не ломает.*
2. **B2 — `IdeaStore` порт + in-memory.** `idea-store.ts` + `in-memory-idea-store.ts`. Проверка: unit на `stale(days)` и фильтр по `Classified`.
3. **B3 — навык + use-case на in-memory.** `inbox_capture.md` + `registry.json`; контракт `InboxClassification`; `IngestionService.captureInbox`; подключение в `AssistantService` (детерминированный форс). Проверка: `SPEC-PERSONAL-ASSISTANT-INBOX-001` на mock-классификаторе. **Полностью работающий срез без БД/сети.**
4. **B4 — каналы Telegram + `/proc/records`.** Ветвление голос/фото/ссылка/текст через ingestion; проекция `/proc/records`. Проверка: spec-кейсы на каждый тип входящего + bounded-проекция. *(Опционально дробится по типам входящего, если срез окажется великоват.)*
5. **B5 — PostgreSQL за портом.** Миграция `0011` + гранты + `postgres-idea-store.ts`; продакшн-композиция проецирует реальные данные. Проверка: persistence-spec (тот же контракт) + ручной smoke. *Откладываем в конец: провозка с миграциями/грантами не блокирует основную ценность.*

Порядок разблокировки: B1 → B2 → B3 (ядро ценности) → B4 (каналы) → B5 (durability). Реальный Mastra-агент-классификатор ставится параллельно B3/B4 (порт `InboxClassifierRunner` уже инжектится).

---

## 7. Этапы зрелости (после DoD)

- **Ветвление типов записи.** `inbox_capture` начинает различать `idea` / `task` / `expense` из одного входящего (`InboxClassification.kind`), `TaskStore`/`ExpenseStore` появляются за тем же паттерном — вход в Фазы C и «финансы».
- **Обобщённый LLM-роутер.** Когда навыков > 1, `AssistantService` переходит с детерминированного форса на strict-JSON router (RFC §8.2) с allow-list; `inbox_capture` становится одним из выбираемых. Триггер `file_uploaded` уже готов.
- **Недельный обзор банка** (Фаза D) и **карта рутины** (Фаза G) поверх `stale()` и `list()` — продуктовые навыки над уже существующим API стора.
- **Полнотекстовый/векторный поиск.** При росте корпуса «материалов» — `tsvector` или `pgvector` отдельной миграцией (RFC §14.2), `IdeaStore` расширяется методом поиска, паттерн порта сохраняется.
- **Связь «идея → задача → продажа».** `Task.originIdeaId` (RFC §6.4) сошьёт банк идей с планированием — межстор-запрос в Фазе C.

---

## 8. Соответствие RFC

| Инвариант RFC | Как соблюдён в фазе |
|---|---|
| Агент не пишет в stores напрямую (§6.4, §7) | Навык возвращает `InboxClassification`; пишет `IngestionService.captureInbox` |
| Единая точка записи (§7) | Все каналы (голос/фото/ссылка/текст) → `IngestionService` |
| `БЕЗ_ПРОЕКТА` ⇒ агент обязан спросить (§6.1) | `needsProjectClarification` + уточняющий вопрос в ответе |
| Не выдумывать факты (§4.1) | Неуверенность → `NO_PROJECT` + вопрос, а не выдуманный проект |
| Owner-изоляция по `userId` (§5.3, §11) | Фильтр по `userId` во всех методах стора; проекции только для аутентифицированного владельца |
| Тестируемость без LLM (§12) | Порт + in-memory адаптер; классификатор инжектируется; specs без сети |
| Внешние действия — только предложение (§7, §9) | Capture-путь ничего не отправляет/не покупает; `toolChoice: "none"` сохраняется |
