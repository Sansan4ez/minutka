# Этап 4: Telegram shell — текстовый MVP и feedback

> **Родительский план:** [time-agent-mastra-plan.md](./time-agent-mastra-plan.md)  
> **Предыдущий этап:** [phase-3.5-agent-manual-lite.md](./phase-3.5-agent-manual-lite.md)  
> **Стартовый тег:** `phase-3.5-agent-manual-lite`  
> **Целевой тег:** `phase-4-telegram-text-feedback`

---

## 1. Цель этапа

Сделать рабочий Telegram-бот для текстового MVP продукта «Минута»: сотрудник открывает бота через `/start`, проходит простой entrypoint onboarding/consent, пишет текстовые сообщения, получает ответы `MinutkaAgent`, а затем может оценить конкретный ответ кнопками 👍/👌/👎.

Главный принцип Phase 4: **Telegram — это shell, а не новый бизнес-слой**. Все смысловые решения остаются в уже реализованных слоях `Application → Server → SDK` и в Agent Vault. Telegram handlers только нормализуют вход Telegram, вызывают SDK/Application API и отображают результат пользователю.

Этап должен быть простым, надёжным и эффективным:

- **простым:** минимум Telegram UI, без сложного FSM, без voice/STT, без scheduler, без отдельной БД;
- **надёжным:** specs не требуют реального Telegram/LLM/API, callback data валидируется, feedback привязан к конкретному ответу;
- **эффективным:** один in-process service/client на процесс бота, manual загружается один раз, handlers не перечитывают vault и не создают тяжёлые объекты на каждый update.

---

## 2. Definition of Done

- [ ] Добавлена dependency `telegraf`.
- [ ] Создан Telegram слой как отдельная внешняя поверхность, например `src/telegram/*`.
- [ ] Runtime entrypoint запускает Telegraf-бота только при наличии `TELEGRAM_BOT_TOKEN`.
- [ ] `.env.example` уже содержит `TELEGRAM_BOT_TOKEN`; при необходимости добавлены комментарии по запуску.
- [ ] `/start` работает:
  - [ ] без параметра показывает короткое приветствие и объясняет, что нужна индивидуальная ссылка/invite code;
  - [ ] с deep-link invite code вызывает onboarding entrypoint через SDK/Application API;
  - [ ] повторный `/start` для уже связанного пользователя не ломает профиль и даёт понятный статус.
- [ ] Текстовое сообщение сотрудника проходит путь `Telegram handler → SDK/API → MinutkaService.chat() → Agent Vault routing → AgentRunner`.
- [ ] Ответ бота отправляется пользователю с inline feedback-кнопками 👍/👌/👎.
- [ ] Feedback callback сохраняется через application use case, а не напрямую в Telegram handler.
- [ ] Feedback содержит минимум:
  - [ ] privacy-safe `employeeId`;
  - [ ] `threadId`;
  - [ ] `targetMessageId` ответа `MinutkaService.chat()`;
  - [ ] rating: `positive | neutral | negative`;
  - [ ] timestamp;
  - [ ] Telegram message metadata остаётся только в Telegram shell/session boundary и не попадает в domain feedback record, domain events, insights или аналитику.
- [ ] `SPEC-FEEDBACK-001` проходит через in-process Telegram adapter/mock update driver без реального Telegram API.
- [ ] Предыдущие specs остаются зелёными.
- [ ] `npm run typecheck` проходит.
- [ ] `npm run specs` проходит.
- [ ] `npm run verify` проходит.
- [ ] `nix run .#verify` проходит.
- [ ] Проведён ручной Telegram smoke E2E с реальным ботом.
- [ ] Коммит и тег `phase-4-telegram-text-feedback`.

---

## 3. Границы этапа

### Входит

1. Telegram text shell на `telegraf`.
2. `/start` как onboarding entrypoint через invite/deep-link.
3. Простая связь Telegram user/chat с privacy-safe `employeeId`.
4. Text message handler.
5. Inline feedback buttons для каждого ответа агента.
6. Application-level feedback model/store/use case.
7. Telegram adapter test harness с mock Telegram API.
8. `SPEC-FEEDBACK-001` на полный путь chat → reply buttons → callback → saved feedback.
9. Минимальная ручная инструкция для запуска и smoke.

### Не входит

- Voice messages и STT — Phase 5.
- Scheduler / daily prompts — Phase 7.
- Production database / migrations / PostgreSQL.
- Rich Telegram меню «Я», «Неделя», «Настройки», удаление данных.
- Web panel методолога.
- Сложный FSM onboarding с несколькими вопросами внутри Telegram.
- Хранение реальных Telegram IDs в company-facing analytics или insights.
- Изменение Agent Vault routing в Telegram handlers.

---

## 4. Архитектурное решение

Сохраняем существующую слойность:

```text
Domain → Application → Server → SDK → CLI / Telegram
                ↓
             Mastra runtime bridge
```

Telegram добавляется как shell рядом с CLI:

```text
Telegram Update
  → Telegraf runtime adapter
  → pure Telegram update handler / driver
  → MinutkaClient SDK
  → In-process server
  → MinutkaService
  → Agent Vault decision plane
  → AgentRunner / feedback store
```

### 4.1 Почему нужен pure handler поверх Telegraf

Чтобы specs не зависели от реального Telegram API, Phase 4 делит Telegram слой на две части:

1. **Pure update handler** — принимает нормализованные update/action objects и вызывает `MinutkaClient` + `TelegramSessionStore` + `TelegramReplyPort`.
2. **Telegraf runtime adapter** — тонкий слой, который переводит `ctx` в нормализованные команды и отправляет реальные сообщения через Telegram.

Это позволяет проверить бизнес-сценарий через mock update driver:

```text
spec sends /start invite_1
spec sends text "Сегодня хочу закрыть отчёт"
spec sees bot reply with feedback buttons
spec clicks callback "fb:p:msg_1"
spec asserts feedback record saved
```

без Telegram token, polling, network и LLM.

### 4.2 Минимальный Telegram namespace

Предлагаемая структура файлов:

```text
src/telegram/
  telegram-types.ts          # normalized update, callback, rating, reply markup types
  telegram-session-store.ts  # mapping Telegram identity -> employeeId/threadId
  in-memory-telegram-session-store.ts
  callback-data.ts           # encode/decode feedback callback data
  telegram-shell.ts          # pure handler: start/text/callback
  telegraf-runtime.ts        # Telegraf wiring and launch
  main.ts                    # optional executable entrypoint
```

Если текущая структура проекта предпочитает `src/server/telegram` или `src/client/telegram`, допустимо выбрать другой путь, но важно сохранить смысл: Telegram является внешней поверхностью, а не application service.

---

## 5. Domain и storage для feedback

В Phase 3.5 уже есть `submitFeedback(input)` и process `vault/processes/feedback.md`, но текущий контракт принимает свободный `text`. Для Phase 4 нужно сделать feedback **структурированным и привязанным к ответу**.

### 5.1 Domain type

Добавить privacy-safe доменные типы, например `src/domain/feedback.ts`, и вынести общий source/channel enum в один shared type, чтобы не дублировать уже существующие значения consent/onboarding:

```ts
// src/domain/channel-source.ts
export type ChannelSource = "telegram" | "cli" | "test";
```

```ts
// src/domain/feedback.ts
import type { ChannelSource } from "./channel-source.js";

export type FeedbackRating = "positive" | "neutral" | "negative";
export type FeedbackSource = ChannelSource;

export type FeedbackRecord = {
  id: string;
  employeeId: string;
  threadId: string;
  targetMessageId: string;
  rating: FeedbackRating;
  createdAt: string;
  source: FeedbackSource;
};
```

Правила приватности:

- `employeeId` остаётся privacy-safe псевдонимом.
- `FeedbackRecord` — domain/application record, поэтому **не содержит** Telegram `chatId`, `userId`, callback id или message transport metadata.
- `source` — privacy-safe enum канала (`telegram | cli | test`), а не transport identifier; он допустим в feedback record/event для audit/debug.
- Telegram identifiers допустимы только внутри `TelegramSessionStore`, normalized Telegram update/reply objects и transient logs для shell debugging; они не копируются в feedback domain store.
- `FeedbackReceived` domain event не должен содержать `transport` и реальные Telegram identifiers; event остаётся privacy-safe audit signal.
- В Phase 4 не показывать индивидуальный feedback компании или методологу.

Если позже понадобится persistent transport audit для Telegram delivery/callback troubleshooting, вводить его отдельным transport-log boundary с retention/privacy решением, а не расширять `FeedbackRecord`.

### 5.2 FeedbackStore boundary

Добавить application boundary:

```text
src/application/feedback-store.ts
src/application/in-memory-feedback-store.ts
```

Минимальный интерфейс:

```ts
export type SaveFeedbackInput = Omit<FeedbackRecord, "id" | "createdAt">;

export interface FeedbackStore {
  saveFeedback(input: SaveFeedbackInput): Promise<FeedbackRecord>;
  getFeedbackByTarget(input: {
    employeeId: string;
    threadId: string;
    targetMessageId: string;
  }): Promise<FeedbackRecord | undefined>;
  listFeedback(input?: {
    employeeId?: string;
    threadId?: string;
    targetMessageId?: string;
  }): Promise<FeedbackRecord[]>;
}
```

`saveFeedback()` генерирует `id`/`createdAt` внутри store/service boundary и возвращает сохранённый record. Для Phase 4 рекомендуемое поведение: **upsert by `(employeeId, threadId, targetMessageId)`** — хранить последнюю оценку и не плодить записи при повторных Telegram clicks. Если реализация выберет append-only, spec должен явно ожидать одну запись только после одного callback; но upsert надёжнее для реального Telegram. `SPEC-FEEDBACK-001` должен проверить повторный callback на тот же `targetMessageId`: при upsert в store остаётся одна запись с последним rating.

`feedbackStore` в `MinutkaServiceDeps` может быть optional только на уровне constructor API; внутри `MinutkaService` должен быть default `createInMemoryFeedbackStore(world)`. У `submitFeedback()` не должно быть silent no-op режима без store.

### 5.3 Message lookup boundary

Для проверки `targetMessageId` не обращаться из `submitFeedback()` напрямую к `world.messages` как к hidden storage. Добавить минимальный application boundary, например:

```text
src/application/message-store.ts
src/application/in-memory-message-store.ts
```

```ts
export interface MessageStore {
  getMessageById(input: {
    messageId: string;
    employeeId: string;
    threadId: string;
  }): Promise<ChatMessage | undefined>;
}
```

`MinutkaService.chat()` пока может продолжать писать в `world.messages`, но validation в `submitFeedback()` должна идти через `messageStore` с default `createInMemoryMessageStore(world)`. Это фиксирует privacy/security check: feedback можно сохранить только для ответа того же `employeeId/threadId`.

### 5.4 InMemoryWorld

Расширить `InMemoryWorld`:

```ts
feedback: FeedbackRecord[];
counters: { message: number; participant: number; insight: number; feedback: number };
```

`createInMemoryWorld()` должен инициализировать `feedback: []` и `counters.feedback = 0`; это изменение делается вместе с типом `InMemoryWorld`, чтобы промежуточный `npm run typecheck` не ломался. Это сохраняет текущую test/storage модель и не вводит premature DB.

### 5.5 Domain event

Обновить `FeedbackReceived`:

```ts
export type FeedbackReceived = {
  type: "FeedbackReceived";
  feedbackId: string;
  employeeId: string;
  threadId: string;
  targetMessageId: string;
  rating: FeedbackRating;
  source: FeedbackSource;
  selectedProcessIds: DecisionProcessId[];
  timestamp: string;
};
```

`feedbackId` нужен для audit-корреляции `FeedbackReceived` ↔ сохранённый `FeedbackRecord`, поэтому event эмитится **после** `FeedbackStore.saveFeedback()`/upsert. `source` в event — только coarse-grained privacy-safe enum канала, не Telegram `chatId`/`userId`/callback id. Если нужно сохранить совместимость с CLI старого `--text`, лучше не поддерживать старую форму, а обновить CLI/API на структурированную команду. Phase 4 — правильный момент заменить placeholder из Phase 3.5. Существующие Phase 3.5 assertions, которые проверяют `FeedbackReceived.text`, нужно обновить на `feedbackId` + `targetMessageId` + `rating` + `source` и отсутствие `transport` в event payload.

---

## 6. Application/API/SDK изменения

### 6.1 Новый контракт `SubmitFeedbackInput`

Заменить placeholder-contract:

```ts
export type SubmitFeedbackInput = {
  employeeId: string;
  threadId: string;
  targetMessageId: string;
  rating: FeedbackRating;
  source: FeedbackSource;
};

export type SubmitFeedbackResult = {
  accepted: true;
  feedbackId: string;
  selectedProcessIds: AgentManualProcessId[];
};
```

### 6.2 `MinutkaService.submitFeedback()`

Flow:

```text
submitFeedback(input)
  1. requireParticipant(employeeId)
  2. verify target message exists through MessageStore for the same employeeId/threadId
  3. route purpose = feedback through ConversationDecisionRouter with non-user sentinel text
  4. build context with selectedProcessIds
  5. create/upsert FeedbackRecord through FeedbackStore
  6. emit FeedbackReceived with feedbackId/targetMessageId/rating/source and without transport metadata
  7. return { accepted, feedbackId, selectedProcessIds }
```

Важное решение: **не вызывать agentRunner для feedback acknowledgement**. Telegram shell сам отвечает коротким `Спасибо, учту 👍`. Это проще, дешевле и стабильнее; Agent Vault process `feedback.md` используется для routing/audit и policy, но не требует LLM-вызова.

Если `targetMessageId` не найден или принадлежит другому `employeeId/threadId`, `submitFeedback()` должен вернуть controlled validation error и не сохранять feedback. Для router-а не передаём свободный пользовательский текст и не кодируем rating/message id в keyword-like строку. Чтобы сохранить текущий обязательный контракт `ConversationDecisionInput.text`, используем named constant, например `STRUCTURED_FEEDBACK_ROUTING_TEXT = "[structured-feedback]"`; routing должен определяться `purpose: "feedback"`, а не парсингом текста или inline magic string.

### 6.3 SDK schemas

Обновить `src/client/sdk/minutka-client.ts`:

- `submitFeedbackRequest` валидирует `targetMessageId`, `rating`, `source`; transport identifiers не входят в публичный feedback contract.
- `submitFeedbackResponse` strict Zod-схема возвращает `feedbackId: z.string().min(1)` вместе с `accepted` и `selectedProcessIds`; иначе `z.strictObject` отклонит новый runtime field.
- `agentManualProcessId` остаётся как сейчас.

### 6.4 CLI feedback command

CLI нужен не как основная surface Phase 4, а как debug/spec fallback. Обновить команду:

```bash
employee feedback \
  --employee emp_1 \
  --thread emp_1 \
  --target-message msg_1 \
  --rating positive
```

`--source` можно оставить default `cli`.

---

## 7. Telegram identity mapping

Нужна простая связь Telegram update с `employeeId`, не раскрывающая Telegram ID за пределы shell/storage boundary.

### 7.1 Session store

Добавить `TelegramSessionStore`:

```ts
export type TelegramIdentity = {
  chatId: string;
  userId?: string; // Telegram PII: shell/session boundary only
};

export type TelegramSession = {
  chatId: string;
  userId?: string; // Telegram PII: do not copy to domain events, insights or aggregates
  employeeId: string;
  threadId: string;
  inviteCode?: string;
  createdAt: string;
  updatedAt: string;
};

export interface TelegramSessionStore {
  getByChatId(chatId: string): Promise<TelegramSession | undefined>;
  save(session: TelegramSession): Promise<void>;
}
```

Phase 4 in-memory adapter допустим. При запуске реального бота без persistent DB связь потеряется после restart — это допустимый MVP-risk, но его нужно явно указать в smoke notes. Если хочется чуть надёжнее без большого усложнения, можно добавить JSON-file adapter позже отдельной задачей, но не блокировать Phase 4.

Privacy rule: `chatId`/`userId` считаются transport identifiers. Они допустимы в `TelegramSessionStore` и normalized Telegram shell objects, но не должны попадать в `FeedbackRecord`, `DomainEvent`, insights, aggregates или company-facing analytics. Если session store станет persistent, `userId`/`chatId` требуют отдельного privacy decision: минимум retention note, preferably hashing/encryption-at-rest для файла/БД.

### 7.2 `/start` с invite code

Telegram deep link обычно приходит как:

```text
/start invite_abc
```

Минимальный flow:

```text
/start <inviteCode>
  → client.openInvite({ inviteCode })
  → save TelegramSession(chatId, userId, employeeId, threadId = employeeId)
  → show privacy explanation
  → show button "Принимаю" with callback tg:consent:<employeeId>
```

Но чтобы не строить сложный FSM, Phase 4 может выбрать один из двух простых вариантов:

#### Вариант A — минимально надёжный для MVP specs

- `/start <inviteCode>` вызывает `openInvite`.
- Бот показывает privacy explanation и инструкцию:
  - для тестового MVP consent/onboarding можно завершить через CLI/API;
  - если профиль уже completed, можно сразу писать сообщения.
- Text chat разрешается только если profile exists; иначе бот просит завершить onboarding.

Минус: в реальном Telegram onboarding неполный.

#### Вариант B — рекомендуемый Phase 4 баланс

Реализовать очень короткий Telegram onboarding без сложного FSM:

1. `/start <inviteCode>` → `openInvite`, показать privacy explanation и inline button `✅ Принимаю`.
2. callback `tg:consent:<employeeId>` → `acceptConsent({ source: "telegram" })`.
3. После consent бот просит отправить одну строку с ролью и задачами в простом формате или предлагает временный default для smoke.

Чтобы не раздувать Phase 4, рекомендуется **не делать многошаговую анкету**. Для ручного smoke можно заранее создать профиль через CLI, а Telegram `/start` только связывает chat с `employeeId`. В specs обязательно покрыть уже готового участника: это проверяет shell/chat/feedback без увязания в onboarding FSM.

Итого рекомендуемое решение: **Phase 4 реализует `/start` + session binding + consent acknowledgement, но полноценное заполнение профиля оставляет существующим CLI/API**. Это соответствует формулировке общего плана: `/start`, onboarding entrypoint, а не полный Telegram onboarding wizard.

---

## 8. Telegram text flow

### 8.1 Handler behavior

```text
onText(update)
  1. find TelegramSession by chatId
  2. if no session: reply "Откройте бота по индивидуальной ссылке /start <code>"
  3. verify profile exists through client.getProfile({ employeeId })
  4. if profile is missing: reply "Сначала завершите onboarding/профиль по индивидуальной ссылке или через CLI/API"
  5. reject or truncate empty/oversized Telegram text before SDK call; Phase 4 limit: no more than 4096 UTF-8 chars; если для chat уже есть in-flight request по тому же chatId, ответить controlled fallback/cooldown message, а не запускать неограниченные параллельные LLM calls
  6. call client.chat({ employeeId: session.employeeId, threadId: session.threadId, text })
  7. send result.response with inline feedback buttons
  8. callback data includes rating + targetMessageId
```

### 8.2 Feedback buttons

Кнопки:

```text
👍  callback_data = fb:p:<messageId>
👌  callback_data = fb:n:<messageId>
👎  callback_data = fb:d:<messageId>
```

Где:

- `p` = positive;
- `n` = neutral;
- `d` = negative/downvote.

Почему коротко: Telegram callback data ограничен 64 bytes. Формат `fb:<code>:<msg_id>` достаточно компактен при текущих id вида `msg_1`. Encoder обязан fail-fast, если итоговый UTF-8 payload >64 bytes; в Phase 4 `messageId` в callback должен оставаться коротким (`msg_<number>` или ≤50 ASCII chars).

`threadId` намеренно не кодируется в callback data, чтобы не выйти за лимит и не раскрывать лишний контекст. Phase 4 исходит из MVP-инварианта `threadId` берётся из `TelegramSession` и для Telegram chat обычно равен `employeeId`; если позже появятся несколько Telegram thread/dialog context на одного сотрудника, callback format/session model нужно пересмотреть отдельной задачей.

### 8.3 Callback validation

`decodeFeedbackCallbackData(data)` должен:

- принимать только `fb:p|n|d:<targetMessageId>`;
- валидировать `targetMessageId` как непустую ASCII-строку без пробелов и без `:`; callback payload целиком должен быть ≤64 bytes, а `targetMessageId` в callback — не длиннее 50 ASCII chars для формата `fb:<code>:<targetMessageId>`;
- парсить формат через явные позиции разделителей (`indexOf`/regex с anchors), а не через `split(":", 3)`, чтобы случайные разделители в payload не приводили к тихому truncation;
- возвращать typed `{ rating, targetMessageId }`;
- для неизвестного callback возвращать controlled error, а не бросать наружу в Telegraf loop.

### 8.4 Feedback callback flow

```text
onCallback(update)
  1. route callback by prefix:
       - `tg:consent:<employeeId>` → consent flow;
       - `fb:<code>:<targetMessageId>` → feedback flow;
       - unknown prefix → controlled callback answer, no throw to Telegraf loop
  2. for feedback: decode callback data
  3. find session by chatId
  4. call client.submitFeedback({
       employeeId: session.employeeId,
       threadId: session.threadId,
       targetMessageId,
       rating,
       source: "telegram"
     })
  5. answer callback query "Спасибо, учту"
  6. optionally edit reply markup or leave buttons as is
```

Простое решение: не редактировать старое сообщение, только `answerCbQuery`. Это меньше API surface и меньше ошибок. Если хочется UX-сигнал, можно заменить кнопки на `Оценка сохранена`, но это не обязательно для DoD.

---

## 9. Runtime запуск

### 9.1 Entry point

Добавить один из вариантов:

```text
src/telegram/main.ts
```

или npm script:

```json
"telegram:dev": "tsx src/telegram/main.ts"
```

Но в проекте сейчас нет `tsx`. Чтобы не добавлять лишний dev runtime, лучше на Phase 4:

- либо компилировать через `tsc` и запускать Node из `dist` только если build появится;
- либо добавить minimal dev dependency `tsx`;
- либо сделать runtime bootstrap импортируемым, а ручной запуск оставить через `mastra dev`/custom later.

Рекомендуемое простое решение: добавить `tsx` как devDependency и script:

```json
"telegram:dev": "tsx src/telegram/main.ts"
```

Если выбирается `tsx`, обязательно проверить `npm run typecheck`, `npm run verify` и `nix run .#verify`; если Nix/dev shell не подхватывает npm devDependency корректно, откатиться к exported `createTelegrafBot()` + запуску через существующий runtime. Так как Telegraf уже новая runtime dependency, `tsx` как dev-only допустим, но не должен ломать Nix baseline.

### 9.2 Composition root

Runtime composition:

```text
createInMemoryWorld()
createInProcessServer(world, mastraAgentRunner)
new MinutkaClient(api)
createInMemoryTelegramSessionStore(world or local object)
createTelegramShell({ client, sessionStore, replyPort })
createTelegrafBot({ token, shell })
bot.launch()
```

Важно: `MinutkaService` и Agent Vault должны создаваться один раз на процесс, а не на каждый Telegram update.

---

## 10. Executable spec: `SPEC-FEEDBACK-001`

### 10.1 Metadata

Product parts:

- `telegram-bot-shell`
- `ai-agent-backend-runtime`
- `data-storage-and-privacy-layer`

Contracts:

- `telegram-shell`
- `chat`
- `submitFeedback`
- `Agent Vault feedback process`

Events:

- `ChatMessageReceived`
- `ChatResponseGenerated`
- `FeedbackReceived`

### 10.2 Test harness

Добавить support driver:

```text
specs/executable/support/telegram-driver.ts
```

Он должен уметь:

```ts
await telegram.start({ chatId, userId, inviteCode });
await telegram.sendText({ chatId, userId, text });
await telegram.clickFeedback({ chatId, userId, rating, targetMessageId });
telegram.sentMessages();
telegram.callbackAnswers();
```

Driver использует pure `telegram-shell.ts`, mock reply port и `createDefaultSpecDeps()` из существующего spec harness. Не завязываться на `createSpecWorld()` как обязательный constructor: он создаёт `CliDriver`, а Telegram driver обычно должен напрямую собрать `createInMemoryWorld()` → `createInProcessServer()` → `MinutkaClient` → `createTelegramShell()`.

### 10.3 Given/When/Then

```text
Given сотрудник уже прошёл onboarding и связан с Telegram chat через /start invite
When он пишет текстовое сообщение в Telegram
Then Telegram shell вызывает chat через SDK/Application
And бот отправляет ответ с кнопками 👍/👌/👎
When сотрудник нажимает 👍
Then submitFeedback сохраняет positive feedback
And feedback привязан к employeeId, threadId, targetMessageId и timestamp
And FeedbackReceived содержит feedbackId, targetMessageId, rating, source = "telegram" и selectedProcessIds = ["core", "feedback"]
And FeedbackReceived не содержит transport/telegramChatId/telegramMessageId/telegramUserId
And specs не используют реальный Telegram token/API
```

### 10.4 Рекомендуемый fixture

Чтобы не зависеть от полного Telegram onboarding wizard, spec может:

1. Через existing helper создать participant/consent/profile.
2. Через Telegram `/start <inviteCode>` связать chat с employeeId.
3. Отправить text.
4. Кликнуть feedback.

Так spec проверяет Phase 4 shell и не превращается в повторный Phase 2 onboarding spec.

### 10.5 Обязательные edge checks в Telegram specs

Обязательный минимум внутри `SPEC-FEEDBACK-001`:

1. `/start` без invite code возвращает понятное приветствие и не создаёт participant/profile.
2. Happy path: `/start <inviteCode>` для уже onboarded employee → text chat → reply buttons → positive callback → saved feedback.
3. `FeedbackReceived` содержит `feedbackId` для audit-корреляции с сохранённым `FeedbackRecord` и не содержит `transport`/`telegramChatId`/`telegramMessageId`/`telegramUserId`.
4. Malformed feedback callback data (`fb:x:...`, пустой `targetMessageId`, пробелы, `:` внутри `targetMessageId`, payload >64 bytes или `targetMessageId` >50 chars) не вызывает `submitFeedback()`.
5. Feedback callback на несуществующий или чужой `targetMessageId` не сохраняет feedback.
6. Повторный feedback callback на тот же `targetMessageId` не создаёт дубль при upsert-стратегии; сохраняется последняя оценка.
7. Повторный `/start <inviteCode>` для уже связанного chat не ломает существующий profile/consent и отвечает статусом.
8. `/start <другойInviteCode>` для уже связанного chat не перезаписывает существующую session и не привязывает chat к другому employee без явного отдельного reset/relink flow.
9. Если реализован `tg:consent:<employeeId>`, callback вызывает `acceptConsent({ source: "telegram" })` через SDK, не принимает consent для employeeId, отличного от текущей session, и не пишет Telegram IDs в domain events.
10. Text message без completed profile не вызывает `client.chat()` и просит завершить onboarding/profile.
11. Unknown callback prefix не падает наружу и отвечает controlled callback answer.
12. Ошибка `client.chat()`/`client.submitFeedback()` возвращает user-facing fallback и не роняет shell.
13. Oversized Telegram text или in-flight/cooldown duplicate по тому же chatId не вызывает неограниченный `client.chat()`/LLM path; shell возвращает controlled fallback или применяет явное ограничение длины/частоты.

Дополнительные checks можно реализовать в том же файле или отдельном executable spec рядом с ним, но пункты выше являются обязательным минимумом для privacy/security/regression покрытия.

Для callback encoder/decoder допустимо добавить executable-level helper test рядом с Telegram spec; отдельную директорию `tests/unit` не заводить.

---

## 11. Последовательность реализации

### Step 0 — Pre-flight

1. Запустить baseline:

```bash
npm run typecheck
npm run specs
```

2. Проверить, что Phase 3.5 specs зелёные.
3. Зафиксировать старт от тега/коммита `phase-3.5-agent-manual-lite`.

### Step 1 — Feedback domain/storage contract

1. Добавить `src/domain/feedback.ts` с privacy-safe `FeedbackRecord` без transport metadata.
2. Расширить `InMemoryWorld.feedback` и `counters.feedback` вместе с `createInMemoryWorld()` initializer.
3. Добавить `FeedbackStore` + `createInMemoryFeedbackStore`; `saveFeedback(input: SaveFeedbackInput)` возвращает сохранённый `FeedbackRecord`.
4. Добавить `MessageStore` + `createInMemoryMessageStore` для проверки принадлежности `targetMessageId` тому же `employeeId/threadId`.
5. Добавить `feedbackStore?: FeedbackStore` и `messageStore?: MessageStore` в `MinutkaServiceDeps`, но внутри constructor всегда создавать defaults (`createInMemoryFeedbackStore(world)`, `createInMemoryMessageStore(world)`).
6. Пока не менять публичный `submitFeedback` contract и shape `FeedbackReceived`, если это ломает существующие specs; breaking contract migration делается атомарно в Step 2. В Step 1 не должно быть нового публичного API, который уже требует `rating/targetMessageId` при старом `submitFeedback(text)`.

Проверка:

```bash
npm run typecheck
```

### Step 2 — Structured `submitFeedback`

1. Атомарно обновить `SubmitFeedbackInput/Result`, `DomainEvent.FeedbackReceived`, SDK schemas, CLI command и существующие feedback specs. Минимальный blast radius старого placeholder-контракта: `src/domain/channel-source.ts`, `src/domain/feedback.ts`, `src/domain/events.ts`, `src/application/minutka-service.ts`, `src/client/sdk/minutka-client.ts`, `src/client/cli/minutka-cli.ts`, `src/server/http/in-process-server.ts`, `specs/executable/agent-manual/SPEC-PROCESS-ROUTING-001.spec.ts`, `specs/executable/support/scripted-deps.ts` если router/test helper начнёт зависеть от нового shape.
2. Реализовать `submitFeedback()` с `rating`, `targetMessageId`, `source`; transport metadata не входит в публичный contract.
3. Использовать `MessageStore` для validation: target message должен существовать и принадлежать тому же `employeeId/threadId`.
4. Использовать `purpose: "feedback"`, чтобы selected process ids включали `feedback`; в `ConversationDecisionRouter.text` передавать non-user sentinel (`"[structured-feedback]"`), а не `feedback:<rating>:<targetMessageId>`.
5. Не вызывать LLM для acknowledgement.
6. Сохранять/upsert feedback через `FeedbackStore`, возвращать `feedbackId`.
7. Обновить CLI `employee feedback` с `--target-message` и `--rating`, старый `--text` не поддерживать.
8. Обновить существующие Phase 3.5 tests, которые проверяют placeholder feedback route. В частности, `SPEC-PROCESS-ROUTING-001` сейчас вызывает `employee feedback --text "👍"` сразу после onboarding и ожидает `FeedbackReceived.text`; после MessageStore validation тест должен сначала отдельным `employee chat` создать valid chat response, взять `messageId` из результата, затем вызвать `employee feedback --target-message <messageId> --rating positive` и ожидать `FeedbackReceived.feedbackId/targetMessageId/rating/source` без transport fields.
9. Обновить `vault/processes/feedback.md`: убрать формулировку, что persistent feedback storage только planned for Phase 4, и описать implemented structured feedback use case.

Проверка:

```bash
npm run typecheck
npm run specs -- --run specs/executable/agent-manual/SPEC-PROCESS-ROUTING-001.spec.ts
```

Если команда с пробросом аргументов неудобна из-за текущего script, можно запускать `npx vitest run <file>`.

### Step 3 — Telegram pure shell

1. Добавить normalized Telegram types.
2. Добавить `TelegramSessionStore` и in-memory adapter.
3. Добавить callback data encoder/decoder.
4. Реализовать `createTelegramShell()`:
   - `handleStart()`;
   - `handleText()`;
   - `handleCallback()`.
5. Shell принимает `MinutkaClient`, session store и reply port.
6. Shell не импортирует `MinutkaService` напрямую.

Проверка:

```bash
npm run typecheck
```

### Step 4 — Telegram spec driver и `SPEC-FEEDBACK-001`

1. Добавить `specs/executable/telegram/SPEC-FEEDBACK-001.spec.ts`.
2. Добавить `specs/executable/support/telegram-driver.ts`.
3. Использовать scripted deps из Phase 3.5:
   - fake conversation decision router;
   - fake insight extractor;
   - mock `AgentRunner`.
4. Проверить, что reply содержит inline feedback buttons.
5. Проверить saved feedback record и `FeedbackReceived` event.
6. Обязательно покрыть malformed callback data и callback на несуществующий/чужой `targetMessageId`: `submitFeedback()` не вызывается или controlled validation error не сохраняет feedback.

Проверка:

```bash
npm run specs
```

### Step 5 — Telegraf runtime adapter

1. Добавить dependency. Перед установкой проверить актуальную major-версию Telegraf; если остаёмся на v4, зафиксировать это как сознательный выбор стабильного API для MVP:

```bash
npm install telegraf@^4
```

2. Добавить `src/telegram/telegraf-runtime.ts`:
   - `bot.start(...)`;
   - `bot.on("text", ...)`;
   - `bot.on("callback_query", ...)`;
   - error handling через `bot.catch(...)`.
3. Добавить `src/telegram/main.ts` composition root.
4. Добавить script `telegram:dev`, если выбран `tsx`.

Проверка:

```bash
npm run typecheck
```

### Step 6 — Manual smoke

1. Создать Telegram bot token через BotFather.
2. Запустить:

```bash
TELEGRAM_BOT_TOKEN=... OPENAI_API_KEY=... npm run telegram:dev
```

3. Подготовить профиль через CLI/API или fixture command.
4. Открыть bot через `/start <inviteCode>`.
5. Отправить текст: `Сегодня хочу закрыть квартальный отчёт`.
6. Убедиться, что пришёл ответ и кнопки 👍/👌/👎.
7. Нажать 👍.
8. Убедиться в callback acknowledgement и логах feedback.

### Step 7 — Final verification

```bash
npm run typecheck
npm run specs
npm run verify
nix run .#verify
```

Затем коммит и тег:

```bash
git add .
git commit -m "phase 4 telegram text feedback"
git tag phase-4-telegram-text-feedback
```

---

## 12. Acceptance criteria

1. **Telegram shell boundary:** Telegram code не содержит agent routing, insight extraction, guardrails или persona logic.
2. **Text path:** входящий Telegram text вызывает тот же `client.chat()`, что CLI/specs.
3. **Agent Vault preserved:** `selectedProcessIds` формируются Application/ContextBuilder, а не Telegram handler-ом.
4. **Feedback structured:** rating хранится как enum, а не свободный текст.
5. **Feedback linked:** feedback связан с `targetMessageId` ответа агента.
6. **No external deps in specs:** `SPEC-FEEDBACK-001` работает без Telegram token, OpenAI key и network.
7. **Privacy:** Telegram IDs не попадают в `FeedbackRecord`, domain events, insights/aggregates или company-facing analytics; они остаются только в Telegram session/shell boundary.
8. **Manual smoke:** реальный Telegram бот отвечает на текст и принимает feedback button.

---

## 13. Риски и решения

| Риск | Решение |
|---|---|
| Telegram handler начнёт содержать бизнес-логику | Pure shell вызывает только SDK и session store; routing/process selection остаётся в Application. |
| Specs станут зависеть от Telegram API | Ввести normalized update driver и mock reply port; Telegraf покрыть typecheck/manual smoke. |
| Callback data превысит лимит Telegram | Использовать компактный формат `fb:p:msg_1` / `fb:n:msg_1` / `fb:d:msg_1`, не сериализовать JSON; encoder fail-fast при >64 bytes, `targetMessageId` в callback ≤50 ASCII chars. |
| Feedback не будет связан с конкретным ответом | Callback data содержит `targetMessageId`, `submitFeedback` требует `targetMessageId`. |
| Пользователь нажмёт кнопку несколько раз | Upsert по `(employeeId, threadId, targetMessageId)` или controlled duplicate handling. |
| Потеря Telegram session после restart | На Phase 4 допустим in-memory store; явно указать MVP limitation. Persistent store вынести отдельно. |
| Реальный Telegram ID попадёт в аналитику | Хранить только в shell/session store и normalized Telegram shell objects; не включать в `FeedbackRecord`, `DomainEvent`, insights или aggregation. |
| `/start` превратится в сложный onboarding wizard | Ограничить Phase 4 session binding + consent entrypoint; полный Telegram onboarding не делать без отдельного плана. |
| Telegraf ошибки уронят процесс | Добавить `bot.catch`, guarded handlers, controlled callback answers и понятные user-facing fallback messages. |
| Пользователь спамит Telegram text и запускает много LLM calls | На Phase 4 минимум ограничить длину текста и добавить лёгкую in-memory защиту в shell boundary: не запускать параллельный `client.chat()` для одного chatId и/или применять короткий cooldown с controlled fallback. Полноценный persisted per-user rate limit вынести отдельной задачей. |
| Callback data не содержит `threadId` | На Phase 4 держать инвариант: `threadId` берётся из `TelegramSession`; при появлении нескольких Telegram threads/dialog contexts на сотрудника пересмотреть callback/session model. |
| Coarse-grained `source` перепутают с transport metadata | Документировать, что `source = telegram|cli|test` privacy-safe и допустим в feedback record/event, а реальные Telegram IDs остаются только в shell/session boundary. |

---

## 14. Минимальный список файлов к изменению

Ориентировочно:

```text
package.json
.env.example                         # только если нужны комментарии
src/domain/channel-source.ts
src/domain/events.ts
src/domain/feedback.ts
src/application/in-memory-world.ts
src/application/feedback-store.ts
src/application/in-memory-feedback-store.ts
src/application/message-store.ts
src/application/in-memory-message-store.ts
src/application/minutka-service.ts
src/client/sdk/minutka-client.ts
src/client/cli/minutka-cli.ts
src/server/http/in-process-server.ts # скорее всего только типы уже протекут автоматически
src/telegram/telegram-types.ts
src/telegram/telegram-session-store.ts
src/telegram/in-memory-telegram-session-store.ts
src/telegram/callback-data.ts
src/telegram/telegram-shell.ts
src/telegram/telegraf-runtime.ts
src/telegram/main.ts
vault/processes/feedback.md
specs/executable/support/telegram-driver.ts
specs/executable/telegram/SPEC-FEEDBACK-001.spec.ts
specs/executable/agent-manual/SPEC-PROCESS-ROUTING-001.spec.ts
```

Если в процессе окажется, что какой-то файл не нужен, не создавать его ради структуры. Предпочтение — минимальному числу понятных файлов.

---

## 15. Что не усложнять в Phase 4

- Не вводить полноценный Telegram FSM library.
- Не делать persistent DB только ради session mapping; если позже появится JSON/DB session store, отдельно решить retention/hash/encryption для Telegram `chatId`/`userId`.
- Не добавлять HTTP server, если in-process server достаточно.
- Не делать LLM acknowledgement на feedback.
- Не делать voice handler «заодно».
- Не смешивать Telegram chat id с `employeeId`.
- Не показывать `selectedProcessIds` пользователю в Telegram UI.
- Не добавлять remote `/proc`/`/bin` endpoints: feedback уже идёт через typed application use case.
