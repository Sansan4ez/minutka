# RFC: диалоговый онбординг с извлечением профиля

## Status

**Proposed.** RFC заменяет Telegram MVP-ввод профиля одной строкой с техническими
разделителями на управляемый диалоговый flow. Он сохраняет `completeOnboarding()`
как единственную точку финального сохранения профиля.

Related documents:

- [Phase 2: onboarding, consent and profile](./minutka-foundation.md)
- [Phase 4: Telegram text and feedback](./minutka-foundation.md)
- [HTTP application API RFC](./rfc-http-application-api.md)
- [Runtime projections RFC](./rfc-runtime-projections.md)
- [HTTP API runtime runbook](../runbooks/http-api-runtime.md)

## Context and problem

После Telegram consent текущий shell предлагает сотруднику прислать одну строку
строго заданного вида:

```text
роль | задача 1; задача 2 | support|efficiency | beginner|intermediate|advanced
```

`src/telegram/telegram-shell.ts` разбирает сообщение через `split("|")` и
создаёт профиль только при полном соответствии формату. Это был полезный
детерминированный MVP для executable specs, но это плохой пользовательский
интерфейс:

- символ `|` неудобен на русской раскладке и не является осмысленной частью
  ответа сотрудника;
- русские названия вариантов («Поддержка», «Эффективность», «новичок») не
  принимаются;
- неполный ответ приводит к повторной демонстрации всей технической строки,
  а не к уточнению конкретного отсутствующего поля;
- пользователь не может проверить распознанный набор данных до сохранения;
- свободный текст с несколькими фактами нельзя использовать без ручного
  переформатирования.

В проекте уже есть `InsightExtractor`, но он запускается после чата сотрудника
с заполненным профилем и извлекает только рабочие инсайты. Его схема и назначение
не подходят для профиля. `updateProfileTool` также не является решением: он
сейчас не сохраняет данные и намеренно не владеет application persistence.

## Decision summary

Вводится отдельный **conversational onboarding** use case, состоящий из:

```text
Telegram text
  → application: submitOnboardingAnswer
  → deterministic normalization + onboarding profile extractor
  → persistent onboarding draft/state
  → one focused follow-up OR confirmation
  → explicit confirmation
  → existing completeOnboarding
  → durable UserProfile + current onboarding events
```

Сотрудник отвечает естественным языком, в одном или нескольких сообщениях.
Система извлекает доступные поля, сохраняет их как черновик, спрашивает только
следующее незаполненное или неоднозначное поле и показывает итог для явного
подтверждения. Технические enum-значения остаются внутренним контрактом;
пользователю показываются русские понятные названия.

Экстракция строится как отдельный typed extractor с жёсткой Zod-схемой,
валидацией и детерминированными fallback-правилами. Она не заменяет application
validation и не получает права напрямую создавать или изменять профиль.

## Goals

1. Позволить пройти onboarding обычным русским текстом, без обязательных `|`,
   английских enum-значений и фиксированного порядка полей.
2. Собирать обязательные поля профиля постепенно: `role`, `typicalTasks`,
   `persona`, `aiLevel`.
3. Задавать один ясный следующий вопрос, если данных не хватает или они
   неоднозначны, вместо показа полной анкеты заново.
4. Дать сотруднику возможность увидеть и подтвердить итог до финального
   сохранения.
5. Переиспользовать одинаковый application flow для Telegram text и
   потенциального web-клиента.
6. Сохранить consent gate, ownership и privacy boundaries: текст не должен
   обходить invite, consent или session validation.
7. Сохранить детерминированность executable specs: LLM не должен быть
   обязательным для проверки корректности flow.
8. Оставить существующий CLI `employee complete-onboarding` прямым
   структурированным интерфейсом для операторов, автоматизации и smoke tests.

## Non-goals

- Не превращать onboarding в неограниченный общий чат с агентом.
- Не принимать consent из свободной фразы: согласие остаётся явным
  callback/API действием.
- Не использовать `InsightExtractor` для профиля и не расширять его схему
  onboarding-полями.
- Не позволять Mastra tool или extractor напрямую писать в `ProfileStore`.
- Не менять смысл существующих `UserProfile`, `completeOnboarding()` и событий
  `UserProfileUpdated` / `OnboardingCompleted`.
- Не добавлять streaming, web-анкету или редактирование полного профиля после
  onboarding в рамках этой работы.

## Design principles and constraints

### Application owns facts; models only propose them

LLM или эвристика возвращает только **кандидатный patch**. Application слой
нормализует значения, проверяет ограничения, объединяет patch с черновиком и
решает, какой вопрос задать. Только `completeOnboarding()` создаёт финальный
`UserProfile`, audit events и первый ответ агента.

### Progressive disclosure

После каждого сообщения flow выбирает ровно один наиболее полезный вопрос.
Он не требует повторить ранее заполненные поля и не заставляет пользователя
воспроизводить внутренние ключи (`support`, `intermediate`).

### Explicit confirmation for model-derived data

Даже полный черновик не становится профилем автоматически. Бот показывает
краткую сводку и ждёт явного подтверждения («Да», «Верно», кнопка «Подтвердить»).
Это предотвращает сохранение ошибочно распознанной роли, задач или предпочтений.

### Bounded and privacy-safe state

Черновик содержит только необходимые профильные поля и минимальный статус
диалога. Он не копирует произвольную историю чата, Telegram identity, invite
code, secret, raw provider response или chain-of-thought. Доступ к нему
выводится из trusted employee scope, как и доступ к профилю.

## User-visible behavior

### First onboarding answer

После принятия consent бот пишет, например:

> Расскажите немного о работе в удобной форме: ваша роль, типичные задачи,
> предпочитаемый стиль общения — «Поддержка» или «Эффективность» — и опыт
> работы с ИИ. Можно ответить одним сообщением или по частям.

Допустимы оба варианта:

```text
Я руководитель проектов. Планирую работы, провожу встречи и координирую подрядчиков.
Хочу стиль «Эффективность», с ИИ уже немного работал.
```

```text
Роль — аналитик.
```

Во втором случае бот сохраняет роль в черновик и продолжает:

> Какие задачи у вас повторяются чаще всего? Например: отчёты, встречи,
> планирование или координация.

### Normalisation of common answers

До вызова extractor-а и после него application применяет allow-listed
нормализацию. Примеры:

| Ответ сотрудника | Canonical value |
|---|---|
| «Поддержка», «поддерживающий стиль» | `support` |
| «Эффективность», «по делу», «коротко и практично» | `efficiency` |
| «новичок», «не пользовался», «только начинаю» | `beginner` |
| «немного работал», «базовый опыт», «средний уровень» | `intermediate` |
| «уверенно использую», «продвинутый» | `advanced` |

Нормализация не должна угадывать неоднозначные случаи. Например, «иногда
спрашиваю ChatGPT» может быть сохранено extractor-ом как кандидат
`intermediate`, но при низкой уверенности flow задаёт прямой вопрос о варианте
уровня.

### Missing and ambiguous values

Порядок обязательных полей фиксирован для предсказуемого UX:

1. роль;
2. типичные задачи;
3. persona;
4. уровень знакомства с AI.

Если extractor вернул несколько кандидатов, конфликт с уже сохранённым
черновиком или низкую уверенность для enum, application не перезаписывает
значение. Вместо этого он просит выбрать вариант. Например:

> Какой стиль вам ближе?
>
> • Поддержка — бережно разбирать ситуацию и задавать вопросы.
> • Эффективность — фокус на приоритетах и следующем практическом шаге.

Telegram использует inline buttons, когда выбор ограничен enum-значениями.
Текстовые ответы («поддержка», «эффективность») равноправно принимаются.

### Confirmation and correction

Когда обязательные поля заполнены, бот отвечает:

> Проверьте, пожалуйста:
> - роль: руководитель проектов;
> - типичные задачи: планирование, встречи, координация подрядчиков;
> - стиль: Эффективность;
> - опыт работы с ИИ: средний.
>
> Всё верно?

Предоставляются кнопки `✅ Подтвердить` и `✏️ Исправить`, а также текстовые
подтверждения и отрицания. При `Исправить` бот спрашивает, что изменить, либо
принимает естественную коррекцию, например «Не средний, а начинающий» или
«Добавь отчёты к задачам». Изменяются только поля, которые extractor уверенно
распознал; остальные значения черновика сохраняются.

После явного подтверждения application вызывает `completeOnboarding()` с
черновиком. При успешном завершении черновик удаляется/закрывается, а бот
отправляет существующий `firstResponse`.

## Architecture

### New application boundaries

Добавляются отдельные application types; имена ниже являются целевым контрактом:

```ts
export type OnboardingField =
  | "role"
  | "typicalTasks"
  | "persona"
  | "aiLevel";

export type OnboardingDraft = {
  employeeId: string;
  role?: string;
  typicalTasks?: string[];
  persona?: Persona;
  aiLevel?: AiLevel;
  status: "collecting" | "awaiting_confirmation";
  pendingField?: OnboardingField;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type OnboardingProfilePatch = {
  role?: string;
  typicalTasks?: string[];
  persona?: Persona;
  aiLevel?: AiLevel;
  ambiguousFields: OnboardingField[];
};

export type OnboardingProfileExtractor = (input: {
  text: string;
  currentDraft: OnboardingDraft;
}) => Promise<OnboardingProfilePatch>;
```

`OnboardingDraft` не включает response-length preference: у него остаётся
детерминированный default `balanced`, пока отдельное явное требование не
добавит его в диалог. Это сохраняет текущий минимальный профиль и не делает
первый onboarding длиннее.

Добавляется port:

```ts
export interface OnboardingDraftStore {
  get(employeeId: string): Promise<OnboardingDraft | undefined>;
  save(draft: OnboardingDraft, expectedRevision?: number): Promise<OnboardingDraft>;
  delete(employeeId: string): Promise<void>;
}
```

`save` должен поддерживать optimistic concurrency либо эквивалентную атомарную
операцию. Два Telegram update не могут потерять разные уже извлечённые поля или
вызвать два `completeOnboarding()`.

### Use cases

`MinutkaService` получает application-facing методы, не зависящие от Telegram:

```ts
submitOnboardingAnswer({ employeeId, text }): Promise<OnboardingProgress>;
confirmOnboarding({ employeeId }): Promise<CompleteOnboardingResult>;
resetOnboardingDraft({ employeeId }): Promise<OnboardingProgress>;
```

`OnboardingProgress` является закрытым DTO, с которым transport рендерит UX:

```ts
type OnboardingProgress =
  | { status: "needs_answer"; field: OnboardingField; prompt: string }
  | { status: "needs_choice"; field: "persona" | "aiLevel"; prompt: string; choices: string[] }
  | { status: "needs_confirmation"; summary: OnboardingSummary }
  | { status: "completed"; result: CompleteOnboardingResult };
```

Shell не решает, какого поля недостаёт, не выполняет `split("|")` и не знает
правила merge. Он только получает Telegram update, проверяет сессию/consent,
вызывает use case от service-scoped employee client и рендерит DTO.

Существующий `completeOnboarding(input)` остаётся доступным структурированным
use case и используется `confirmOnboarding()` внутри одной application
транзакционной/идемпотентной границы. Прямой HTTP/CLI путь не должен создавать
черновик неявно.

### Extractor composition

Новый `OnboardingProfileExtractor` располагается отдельно от
`InsightExtractor`, например:

```text
src/application/onboarding-profile-extractor.ts
src/mastra/onboarding-profile-extractor.ts
src/mastra/agents/onboarding-profile-extractor-agent.ts
```

Он получает только:

- новое текстовое сообщение;
- текущий минимальный черновик;
- инструкции вернуть JSON строго по schema.

Он **не получает** весь Telegram transcript, identity, invite code, полный
system prompt или secrets. Данные пользователя размечаются как untrusted text
и не могут изменять extractor instructions.

Structured-output schema запрещает произвольные ключи и использует nullable
поля. Для каждого enum extractor обязан вернуть canonical value либо `null`;
не допускаются выдуманные значения. Любой ответ проходит Zod validation,
системную нормализацию и `validateProfileInput` перед финальным сохранением.

### Deterministic fallback

Extractor может быть недоступен, вернуть невалидный JSON, таймаут или
низкоуверенный результат. В таком случае flow не завершается ошибкой для
сотрудника и не сохраняет догадки. Он:

1. применяет детерминированную нормализацию простых известных ответов;
2. сохраняет только однозначно извлечённые поля;
3. задаёт вопрос о первом обязательном незаполненном поле.

Это позволяет пройти onboarding без LLM: пользователь отвечает на чёткие
вопросы и выбирает inline buttons. Неудачный extractor наблюдаем внутренне,
но его raw exception и provider payload не показываются пользователю.

### State lifecycle and expiration

Черновик создаётся только после consent и хранится по `employeeId` в
production store. Рекомендуемый TTL — **30 дней с последнего обновления**.

- Повторный `/start` или новое сообщение до TTL продолжает тот же черновик.
- После TTL draft удаляется или считается отсутствующим; бот начинает сбор
  заново и не показывает потенциально устаревшие данные.
- После успешного `completeOnboarding` draft удаляется.
- `resetOnboardingDraft` доступен только текущему employee scope и требует
  явной команды/кнопки «Начать заново».
- Завершённый `UserProfile` остаётся источником истины; draft нельзя применять
  к уже завершённому профилю без отдельного будущего profile-edit flow.

## Telegram transport behavior

### Text

После consent `handleText` проверяет профиль. Если профиля нет, он вызывает
`submitOnboardingAnswer`, а не локальный `parseOnboardingProfile`. Успешный
обычный текст превращается в `OnboardingProgress` и отображается shell-ом.

Telegram callback data несёт только короткое action значение, например
`ob:confirm` или `ob:persona:support`; employee scope и текущий draft всегда
берутся из проверенной session. Callback должен оставаться в лимите Telegram
64 bytes и не включать роль, задачи, текст или внешние идентификаторы.

## API, CLI and compatibility

Для Telegram service plane добавляются scoped operations, например:

```text
POST /v1/service/employees/:employeeId/onboarding/answers
POST /v1/service/employees/:employeeId/onboarding/confirm
POST /v1/service/employees/:employeeId/onboarding/reset
```

Employee web/API plane может иметь эквивалентные `/v1/me/onboarding/*` routes.
Все endpoint-ы требуют соответствующий employee/service principal; тело не
может выбрать другой `employeeId`.

`employee complete-onboarding` сохраняется без изменений как явный
структурированный CLI контракт. Опциональная будущая интерактивная CLI-команда
может вызывать новые employee endpoints, но не входит в данную RFC.

На время миграции старый pipe-separated ввод может приниматься только как один
из вариантов свободного текста и обрабатываться extractor/normalizer. Он не
показывается в prompt, документации или новых UI. После выпуска удалить
`onboardingFormat` и `parseOnboardingProfile` из Telegram shell.

## Error handling and idempotency

- Без participant или consent use cases возвращают существующие controlled
  errors (`participant_not_found`, `consent_required`); shell не запускает
  extractor до этих проверок.
- Неуспех extractor-а или сетевого провайдера не разрушает черновик и не
  превращается в generic failure, если можно задать следующий детерминированный
  вопрос.
- `confirmOnboarding` допускает повтор delivery: один employee/draft revision
  создаёт один профиль и один `OnboardingCompleted` event. Повтор после
  завершения возвращает идемпотентный completed result.
- Конфликт revisions перечитывает draft и возвращает актуальный следующий
  `OnboardingProgress`; transport не должен стирать состояние по старому update.
- Неверный callback, несуществующая session или чужой Telegram user сохраняют
  существующие безопасные ответы shell-а и не читают/не изменяют draft.
- Никакой error response не содержит prompt, provider payload, stack trace
  или чужой draft.

## Implementation outline

1. **Extract pure onboarding state machine.** Определить обязательные поля,
   status, merge/conflict semantics, missing-field order, русские prompts,
   summary и deterministic normalisation как pure application functions.
2. **Add persistent draft boundary.** Реализовать `OnboardingDraftStore` для
   in-memory specs и PostgreSQL runtime, TTL cleanup и atomic revision update.
3. **Add extractor contract.** Реализовать strict Zod schema и
   `OnboardingProfileExtractor`; сначала сделать deterministic fake для specs,
   затем Mastra structured-output adapter с timeout/fallback.
4. **Add application use cases.** Подключить draft store/extractor к
   `MinutkaService`, сохранить `completeOnboarding()` finalizer и обеспечить
   idempotent confirmation.
5. **Expose transports.** Расширить contracts, HTTP transports и service
   employee client только нужными scoped methods. Не передавать raw identity
   через request body.
6. **Replace Telegram parser.** Удалить pipe-only parser, отрисовывать progress
   DTO и callback actions, добавить retry/reset UX.
7. **Test text path end-to-end.** Добавить executable specs с несколькими
   естественными сообщениями, русскими enum-значениями, partial answers,
   confirmation, repeated updates и extractor failure.
8. **Update docs/runbooks.** Удалить примеры обязательного `|` из Telegram
   instructions и описать human-readable onboarding flow.

## Testing approach

### Unit tests

- Нормализация маппит известные русские и английские синонимы в допустимые enum.
- State machine выбирает первое отсутствующее поле и не повторяет заполненное.
- Частичный patch merge-ится без потери предыдущих валидных полей.
- Неоднозначный/конфликтующий patch не перезаписывает черновик.
- Summary рендерит только human-readable значения и не содержит technical IDs.
- Невалидный extractor JSON, таймаут и exception приводят к fallback question,
  а не к созданию профиля.
- Confirm без полного draft невозможен; confirm полного draft вызывает
  `completeOnboarding` ровно один раз.

### Contract and integration tests

- Zod schemas отклоняют неизвестные keys, задачи вне лимита 1–7 и неразрешённые
  enum значения.
- HTTP/service routes выводят employee scope из principal и отклоняют попытку
  доступа к draft другого сотрудника.
- Concurrent answers не теряют fields; concurrent confirms не создают
  дублирующие events/profile writes.
- PostgreSQL draft переживает restart до истечения TTL и недоступен после TTL.
- Прямой CLI `complete-onboarding` остаётся совместимым и не зависит от
  extractor-а.

### Executable Telegram specs

1. Естественный полный русский ответ создаёт draft, показывает summary и
   завершает профиль только после callback/text confirmation.
2. Ответ только с ролью вызывает вопрос о задачах; последующие ответы заполняют
   остальные поля без повторного запроса роли.
3. Русские «Поддержка»/«Эффективность» и уровни AI нормализуются корректно.
4. Неясный уровень AI предлагает выбор и не сохраняет угаданный enum.
5. Исправление одного поля меняет только это поле в summary.
6. Повторный `/start`, duplicate Telegram update и повтор `confirm` являются
   идемпотентными.
7. Недоступный extractor позволяет пройти flow через явные вопросы/buttons.
8. Пользователь без consent, чужой Telegram user и malformed callback не могут
   создавать, читать или подтверждать draft.
9. После завершения стандартный chat и feedback flow продолжают работать.

## Acceptance criteria

RFC считается реализованной для text onboarding, когда:

- Telegram больше не требует от сотрудника вводить `|`, `support`,
  `efficiency` или AI enum на английском языке;
- один естественный полный ответ и последовательность частичных ответов могут
  заполнить все четыре обязательных поля;
- отсутствующее поле вызывает один конкретный follow-up, а не повтор полного
  технического шаблона;
- данные показываются сотруднику в summary и не сохраняются как финальный
  профиль без явного подтверждения;
- `completeOnboarding()` остаётся единственным final profile write path;
- extractor имеет strict schema, не может писать в storage напрямую и имеет
  deterministic fallback;
- черновик имеет scoped persistent storage, TTL и защиту от concurrent updates;
- consent/session/cross-employee ограничения остаются соблюдёнными;
- existing structured CLI onboarding, normal chat, feedback и executable specs
  остаются зелёными;
- provider payloads, prompts и stack traces не попадают в drafts, profiles,
  standard logs или API responses.

## Alternatives considered

### Keep the `|` grammar and improve its help text

Rejected. Это сохраняет технический барьер, требует неудобного символа на
русской раскладке и не решает partial answers, correction и confirmation.

### Reuse `InsightExtractor`

Rejected. Его purpose, входные данные, lifecycle и schema относятся к рабочим
insights после чата, а не к profile onboarding. Смешение приведёт к расширению
privacy surface и неявной зависимости onboarding от decision `candidate`.

### Let `updateProfileTool` persist extracted values

Rejected. Tool не является trusted application mutation boundary. Он не должен
обходить consent, profile validation, audit, confirmation и idempotency.

### Make the LLM conduct the entire onboarding autonomously

Rejected. Consent, required fields, enum constraints, confirmation, storage и
privacy/audit requirements должны оставаться детерминированными и проверяемыми.
LLM допустим только как bounded extractor, а не как владелец state machine.

### Save every free-text onboarding message as a permanent profile transcript

Rejected. Для профиля достаточно нормализованных полей и небольшого временного
черновика. Полный transcript увеличивает privacy/retention surface без
необходимости для поставленной задачи.

