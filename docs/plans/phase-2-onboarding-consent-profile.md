# Этап 2: Онбординг, consent и профиль — подробный план

> **Родительский план:** [time-agent-mastra-plan.md](./time-agent-mastra-plan.md)  
> **Предыдущий этап:** [phase-1-skeleton-and-test-harness.md](./phase-1-skeleton-and-test-harness.md)  
> **Стартовый тег:** `phase-1-skeleton`  
> **Целевой тег:** `phase-2-onboarding`

---

## 1. Цель этапа

Сделать минимальный, проверяемый онбординг сотрудника:

- участник открывает invite/deep-link;
- получает понятное privacy explanation;
- подтверждает участие и принимает условия приватности;
- отвечает на стартовые вопросы профиля;
- выбирает персону `support` / `efficiency`;
- профиль сохраняется под privacy-safe `employeeId`;
- следующий ответ `MinutkaAgent` получает динамический контекст профиля и отвечает в выбранном стиле;
- всё проверяется executable spec без реального LLM/API.

Этап не реализует Telegram shell, голос, memory, insights и полноценную БД. Он закладывает доменные типы, application API, SDK/CLI surface и storage boundary так, чтобы Phase 3–4 не требовали ломать слои.

---

## 2. Definition of Done

- [ ] Добавлена и проходит `SPEC-ONBOARDING-001`.
- [ ] `SPEC-SKELETON-001` остаётся зелёной.
- [ ] Domain содержит `Participant`, `Consent`, `UserProfile`, onboarding events.
- [ ] Application service умеет открыть invite, принять consent, завершить onboarding и отдать профиль.
- [ ] `openInvite()` и `acceptConsent()` идемпотентны: повторные вызовы не создают дубли и не перезаписывают исходные timestamps.
- [ ] Отказ/неявное принятие consent явно блокирует дальнейший onboarding с предсказуемой ошибкой.
- [ ] SDK валидирует onboarding request/response через Zod.
- [ ] CLI поддерживает команды onboarding flow.
- [ ] `AgentRunner` получает динамический контекст: persona, role, AI level, предпочтения.
- [ ] Добавлен deterministic prompt/context builder и покрыт executable spec через mock-agent runner.
- [ ] Подготовлен storage interface для профилей/consent/onboarding; spec использует in-memory adapter.
- [ ] Добавлен `updateProfileTool` или зафиксирован application-level updater; Mastra tool импортируется без ошибок и не ломает smoke.
- [ ] `npm run typecheck` проходит.
- [ ] `npm run specs` проходит.
- [ ] `npm run verify` проходит.
- [ ] `nix run .#verify` проходит.
- [ ] Коммит и тег `phase-2-onboarding`.

---

## 3. Границы этапа

### Входит

1. Доменные типы и события onboarding.
2. Privacy-safe employee identity для MVP.
3. Consent record с версией privacy explanation.
4. Профиль сотрудника:
   - роль;
   - типовые задачи;
   - persona;
   - AI level;
   - предпочтения формата ответа.
5. Application use cases:
   - open invite;
   - accept consent;
   - complete onboarding;
   - get profile;
   - chat с профилем в динамическом контексте.
6. In-memory storage adapter через интерфейс repository/storage.
7. CLI/SDK/API команды для executable spec.
8. `SPEC-ONBOARDING-001`.
9. Mastra-compatible `updateProfileTool` как минимальный импортируемый tool, если это не усложняет слой application.

### Не входит

- Реальный Telegram `/start` и deep-link handler — Phase 4.
- Голосовые сообщения и STT — Phase 5.
- Mastra Memory для conversation history — Phase 3.
- Insight extraction — Phase 3.
- Feedback buttons — Phase 4.
- PostgreSQL, migrations, encryption, KMS, retention policy.
- Веб-панель методолога.
- Реальный LLM-вызов в specs.

---

## 4. Архитектурное решение этапа

Сохраняем слойность Phase 1:

```text
Domain → Application → Server → SDK → CLI / future Telegram
                ↓
         Mastra runtime bridge
```

Ключевое решение: onboarding реализуется как **application flow**, а не как свободный LLM-диалог. LLM/agent может формировать первый приветственный ответ, но факты профиля, consent и статус онбординга сохраняются детерминированно application service.

Причины:

- consent нельзя доверять стохастическому tool-call;
- executable spec должен быть стабильным;
- Telegram Phase 4 сможет вызывать те же use cases;
- privacy/audit события должны быть явными.

`updateProfileTool` в Phase 2 нужен как Mastra primitive и будущая точка расширения, но основной executable flow должен проходить через application service. Tool либо вызывает тот же `ProfileUpdater`, либо остаётся тонкой оболочкой над pure-функцией обновления профиля.

---

## 5. Доменная модель

### 5.1 Новые value types

Файл: `src/domain/employee.ts` или новый `src/domain/onboarding.ts`.

```ts
export type Persona = "support" | "efficiency";

export type AiLevel = "beginner" | "intermediate" | "advanced";

export type ResponseLengthPreference = "short" | "balanced" | "detailed";

export type OnboardingStatus =
  | "invite_opened"
  | "consent_accepted"
  | "profile_completed";
```

### 5.2 Participant

```ts
export type Participant = {
  employeeId: string;        // privacy-safe pseudonym, e.g. emp_test_1
  inviteCode: string;        // technical invite/deep-link code
  status: OnboardingStatus;
  createdAt: string;
  updatedAt: string;
};
```

Правила:

- `employeeId` не является ФИО и не содержит внешний Telegram ID.
- На MVP `employeeId` может быть детерминированно передан в CLI/spec.
- В будущем Telegram adapter будет мапить invite/telegram user на privacy-safe id вне публичной аналитики.

### 5.3 Consent

```ts
export type Consent = {
  employeeId: string;
  privacyVersion: "privacy-v1";
  acceptedAt: string;
  explanationShownAt: string;
  source: "cli" | "telegram" | "test";
};
```

Минимальный текст privacy explanation фиксируем константой:

```ts
export const currentPrivacyVersion = "privacy-v1" as const;

export const privacyExplanation = [
  "Минутка хранит ваш личный рабочий контекст, чтобы помогать вам разбирать день.",
  "Компания не получает личные диалоги, ФИО, индивидуальные задачи или ваше состояние.",
  "Для компании используются только обезличенные агрегированные сигналы по группам от 5 сотрудников.",
].join("\n");
```

### 5.4 UserProfile

Расширить текущий `UserProfile`:

```ts
export type UserProfile = {
  employeeId: string;
  role: string;
  typicalTasks: string[];
  persona: Persona;
  aiLevel: AiLevel;
  responseLength: ResponseLengthPreference;
  preferredCheckinsPerDay?: 1 | 2 | 3;
  createdAt: string;
  updatedAt: string;
};
```

Минимальные правила валидации:

- `role` — непустая строка.
- `typicalTasks` — 1–7 непустых строк.
- `persona` — только `support` или `efficiency`.
- `aiLevel` — только `beginner`, `intermediate`, `advanced`.
- `responseLength` — default `balanced`, если не передан.

### 5.5 Domain events

Расширить `src/domain/events.ts`:

```ts
export type InviteOpened = {
  type: "InviteOpened";
  employeeId: string;
  inviteCode: string;
  timestamp: string;
};

export type PrivacyExplanationShown = {
  type: "PrivacyExplanationShown";
  employeeId: string;
  privacyVersion: string;
  timestamp: string;
};

export type ConsentAccepted = {
  type: "ConsentAccepted";
  employeeId: string;
  privacyVersion: string;
  timestamp: string;
};

export type UserProfileUpdated = {
  type: "UserProfileUpdated";
  employeeId: string;
  changedFields: string[];
  timestamp: string;
};

export type OnboardingCompleted = {
  type: "OnboardingCompleted";
  employeeId: string;
  persona: "support" | "efficiency";
  timestamp: string;
};
```

`DomainEvent` должен включить эти события и старые chat events.

---

## 6. Application/storage дизайн

### 6.1 Почему нужен storage interface

Phase 1 использует `InMemoryWorld`. В Phase 2 нужно не привязаться к нему как к единственной БД, а выделить boundary:

- executable specs продолжают использовать in-memory;
- позднее можно добавить SQLite/libSQL/PostgreSQL без смены SDK/CLI/API;
- consent/profile становятся отдельными коллекциями, а не произвольными массивами.

### 6.2 Минимальный repository interface

Новый файл: `src/application/profile-store.ts` или `src/application/storage.ts`.

```ts
export type ProfileStore = {
  saveParticipant(participant: Participant): Promise<void>;
  getParticipant(employeeId: string): Promise<Participant | undefined>;
  getParticipantByInvite(inviteCode: string): Promise<Participant | undefined>;

  saveConsent(consent: Consent): Promise<void>;
  getConsent(employeeId: string): Promise<Consent | undefined>;

  saveProfile(profile: UserProfile): Promise<void>;
  getProfile(employeeId: string): Promise<UserProfile | undefined>;
};
```

Для Phase 2 достаточно реализовать `InMemoryProfileStore` поверх `InMemoryWorld` или как отдельный adapter.

### 6.3 Расширение `InMemoryWorld`

Файл: `src/application/in-memory-world.ts`.

Добавить:

```ts
participants: Participant[];
consents: Consent[];
profiles: UserProfile[];
counters: { message: number; participant: number };
```

Можно не добавлять отдельный класс repository, если проще, но предпочтительно создать adapter:

```ts
export function createInMemoryProfileStore(world: InMemoryWorld): ProfileStore
```

Так executable spec сможет проверять состояние через world, а application service будет зависеть от interface.

### 6.4 Persistent storage

На этом этапе фиксируем интерфейс и не заставляем specs зависеть от файла/SQLite.

Варианты реализации:

1. **Обязательный минимум:** `ProfileStore` + `InMemoryProfileStore`.
2. **Опционально, если остаётся время:** `JsonFileProfileStore` в `src/application/json-file-profile-store.ts` для локального persistence без новых зависимостей.
3. **SQLite/libSQL — не обязательный код Phase 2:** Mastra docs показывают, что SQLite-compatible adapter находится в отдельном пакете `@mastra/libsql`. Подключать его стоит отдельным решением, чтобы не смешивать onboarding с Mastra Memory/Storage, запланированными на Phase 3.

---

## 7. Application service API

Файл: `src/application/minutka-service.ts` можно расширить, но лучше разделить:

- `MinutkaService` — façade для chat + onboarding;
- или новый `OnboardingService`, который используется `createInProcessServer`.

Для минимального изменения допустимо расширить `MinutkaService`.

### 7.1 Input/Output types

```ts
export type OpenInviteInput = {
  inviteCode: string;
  employeeId?: string; // для spec/CLI; Telegram позже будет использовать mapping
};

export type OpenInviteResult = {
  employeeId: string;
  inviteCode: string;
  status: OnboardingStatus;
  privacyVersion: string;
  privacyExplanation: string;
};

export type AcceptConsentInput = {
  employeeId: string;
  accepted: true;
  source: "cli" | "telegram" | "test";
};

export type AcceptConsentResult = {
  employeeId: string;
  privacyVersion: string;
  acceptedAt: string;
};

export type CompleteOnboardingInput = {
  employeeId: string;
  role: string;
  typicalTasks: string[];
  persona: Persona;
  aiLevel: AiLevel;
  responseLength?: ResponseLengthPreference;
  preferredCheckinsPerDay?: 1 | 2 | 3;
};

export type CompleteOnboardingResult = {
  employeeId: string;
  status: "profile_completed";
  profile: UserProfile;
  firstResponse: string;
};
```

### 7.2 Use case: `openInvite()`

Поведение:

1. Найти participant по `inviteCode`.
2. Если participant уже есть — вернуть его текущий `employeeId` и `status`; не создавать дубль.
3. Если participant уже есть и во входе передан другой `employeeId` — вернуть ошибку `invite already belongs to another employee`.
4. Если participant нет — создать participant с `status = "invite_opened"`.
5. Эмитить `InviteOpened` только при первом создании participant.
6. Эмитить `PrivacyExplanationShown` каждый раз, когда explanation реально возвращается пользователю: это audit-факт показа, а не изменение состояния.
7. Вернуть `privacyExplanation`, `privacyVersion`, `employeeId`, `inviteCode` и текущий `status`.

Для CLI/spec допускается передавать `employeeId`. Если не передан — генерировать `emp_${counter}`.

Идемпотентность: повторный `openInvite(inviteCode)` безопасен, не меняет `createdAt`, не создаёт второго participant и не откатывает статус, если сотрудник уже принял consent или завершил профиль.

### 7.3 Use case: `acceptConsent()`

Поведение:

1. Проверить participant существует.
2. Проверить `accepted === true`.
3. Если `accepted !== true` — вернуть ошибку `privacy consent must be explicitly accepted`; `Consent` не сохранять, `ConsentAccepted` не эмитить, статус participant не менять.
4. Если `Consent` уже существует — вернуть существующий `acceptedAt` и `privacyVersion`; не создавать дубль, не перезаписывать `acceptedAt`, не эмитить повторный `ConsentAccepted`.
5. Если consent ещё нет — сохранить `Consent` с `privacy-v1`.
6. Обновить participant status на `consent_accepted`, но не откатывать `profile_completed`, если onboarding уже был завершён.
7. Эмитить `ConsentAccepted` только при первом принятии.

### 7.4 Use case: `completeOnboarding()`

Поведение:

1. Проверить participant существует.
2. Проверить consent принят; без consent завершение запрещено ошибкой `consent is required before onboarding can be completed`.
3. Валидировать поля профиля.
4. Сохранить/обновить `UserProfile`.
5. Обновить participant status на `profile_completed`.
6. Эмитить `UserProfileUpdated` с реальными `changedFields`; при первом сохранении changed fields включают все заполненные поля профиля.
7. Эмитить `OnboardingCompleted` только при переходе в `profile_completed`; повторное редактирование уже завершённого профиля не должно создавать второй `OnboardingCompleted`.
8. Сформировать динамический контекст профиля.
9. Вызвать `agentRunner` с onboarding message/context, чтобы получить первый ответ.
10. Вернуть profile + firstResponse.

Повторный `completeOnboarding()` после consent допустим как обновление профиля: он перезаписывает изменённые поля, обновляет `updatedAt`, эмитит `UserProfileUpdated`, но не создаёт новый participant/consent.

Важно: firstResponse в executable spec генерируется mock-runner; реальный LLM не нужен.

### 7.5 Chat должен учитывать профиль

Существующий `chat(input)` меняется так:

1. Перед `agentRunner(input, context)` service пытается получить profile по `employeeId`.
2. Если profile есть — строит dynamic context.
3. Если profile нет — работает как Phase 1, чтобы `SPEC-SKELETON-001` не сломалась.
4. `ChatInput` не расширяется profile-specific полями: контекст профиля передаётся только вторым аргументом `AgentRunner`, чтобы транспортный контракт `chat` остался прежним.

Рекомендуемый тип runner:

```ts
export type AgentRunContext = {
  profile?: UserProfile;
  systemContext?: string;
  purpose: "chat" | "onboarding_first_response";
};

export type AgentRunner = (
  input: ChatInput,
  context?: AgentRunContext,
) => Promise<string>;
```

Совместимость со старыми mock-runner сохраняется: функция с одним аргументом типизируется как совместимая с двумя аргументами, если второй аргумент optional. При реализации всё равно нужно явно обновить места типизации:

- `src/application/minutka-service.ts`: `AgentRunner` становится context-aware;
- `src/mastra/agent-runner.ts`: принимает `(input, context)` и пробрасывает `context?.systemContext` в Mastra;
- `specs/executable/support/spec-harness.ts`: `createSpecWorld(agentRunner: AgentRunner)` остаётся, но новые спеки могут наблюдать второй аргумент;
- существующие mock-runner в Phase 1 оставить валидными: `async () => "ok"` должен компилироваться;
- если TypeScript начнёт требовать полную сигнатуру в конкретном месте, обновлять mock до `async (_input, _context) => "ok"`, не менять публичный `chat` contract.

---

## 8. Dynamic prompt/context builder

Новый файл: `src/application/minutka-context-builder.ts` или `src/mastra/minutka-context.ts`.

Лучше держать builder в `application`, потому что он использует продуктовые правила и тестируется без Mastra.

### 8.1 Функция

```ts
export function buildMinutkaProfileContext(profile: UserProfile): string
```

### 8.2 Содержание контекста

Контекст должен быть коротким и стабильным:

```text
Профиль сотрудника:
- Роль: менеджер проектов
- Типовые задачи: встречи, отчёты, координация подрядчиков
- Уровень знакомства с ИИ: intermediate
- Предпочтительная длина ответа: short

Выбранная персона: Эффективность.
Правила тона:
- отвечай по делу, структурно, без лишнего сочувствия;
- помогай найти следующий практический шаг;
- не дави и не оценивай.

Если сотрудник не знаком с ИИ, не упоминай ChatGPT/нейросети первым.
```

### 8.3 Persona rules

`support`:

- тёплый, бережный тон;
- сначала признать состояние/нагрузку, затем предложить структуру;
- избегать давления и директивности.

`efficiency`:

- кратко, прикладно, структурно;
- фокус на приоритетах, экономии времени и следующем шаге;
- без жёсткого контроля и оценок.

### 8.4 AI level rules

`beginner`:

- не упоминать ChatGPT/нейросети первым;
- говорить про шаблоны, упрощение, повторяемость.

`intermediate` / `advanced`:

- можно аккуратно предложить ускорение через ИИ-инструменты, если это уместно;
- не обучать ИИ-инструментам в рамках обычного ответа.

### 8.5 Integration with Mastra runner

Файл: `src/mastra/agent-runner.ts`.

По Mastra docs установленной версии `Agent.generate()` принимает `options.system` / `options.instructions` и `options.memory`. На Phase 2 memory не включаем, используем `system` или `context`.

Пример направления реализации:

```ts
export const runMinutkaAgent: AgentRunner = async (input, context) => {
  const result = await minutkaAgent.generate(input.text, {
    system: context?.systemContext,
  });
  return result.text ?? "";
};
```

Перед реализацией обязательно перепроверить embedded docs установленной версии:

- `node_modules/@mastra/core/dist/docs/references/reference-agents-generate.md`
- `node_modules/@mastra/core/dist/docs/references/reference-agents-agent.md`

---

## 9. Mastra `updateProfileTool`

### 9.1 Решение

Добавить tool как импортируемый Mastra primitive, но не делать его обязательным для deterministic onboarding spec.

Причина: в реальном агентском диалоге tool-call может обновлять профиль, но consent/onboarding в MVP должен быть управляем application flow.

### 9.2 Файл

`src/mastra/tools/update-profile-tool.ts`

### 9.3 Tool shape

По embedded docs Mastra используется `createTool` из `@mastra/core/tools`:

```ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const updateProfileTool = createTool({
  id: "update-profile-tool",
  description: "Create or update a Minutka employee profile after explicit onboarding answers.",
  inputSchema: z.object({
    employeeId: z.string().min(1),
    role: z.string().min(1).optional(),
    typicalTasks: z.array(z.string().min(1)).optional(),
    persona: z.enum(["support", "efficiency"]).optional(),
    aiLevel: z.enum(["beginner", "intermediate", "advanced"]).optional(),
    responseLength: z.enum(["short", "balanced", "detailed"]).optional(),
  }),
  outputSchema: z.object({
    updated: z.boolean(),
    changedFields: z.array(z.string()),
  }),
  execute: async (input) => {
    // Phase 2 minimal version: pure validation/changedFields only,
    // or delegate to injected updater later through requestContext.
    return { updated: true, changedFields: Object.keys(input).filter((k) => k !== "employeeId") };
  },
});
```

### 9.4 Подключение к агенту

В `src/mastra/agents/minutka-agent.ts`:

```ts
tools: { updateProfileTool }
```

Инструкции агента дополнить:

- обновлять профиль только по явным ответам пользователя;
- не менять consent;
- не записывать чувствительные данные, не нужные для рабочего контекста.

### 9.5 Ограничение

Если типы Mastra tool начнут усложнять этап, допустимо:

- создать tool и экспортировать его из `src/mastra/tools/index.ts`;
- не подключать к агенту до Phase 3;
- зафиксировать это в комментарии и spec smoke.

Но предпочтительный результат Phase 2 — tool подключён и smoke import проходит.

---

## 10. Server API surface

Файл: `src/server/http/in-process-server.ts`.

Добавить методы:

```ts
return {
  chat(input: ChatInput) { ... },
  openInvite(input: OpenInviteInput) { ... },
  acceptConsent(input: AcceptConsentInput) { ... },
  completeOnboarding(input: CompleteOnboardingInput) { ... },
  getProfile(input: { employeeId: string }) { ... },
};
```

`createInProcessServer` должен принимать либо:

```ts
createInProcessServer(world, agentRunner)
```

и внутри создавать in-memory store, либо новый объект зависимостей:

```ts
createInProcessServer({ world, profileStore, agentRunner })
```

Для минимального blast radius лучше сохранить старую сигнатуру и добавить optional deps:

```ts
export function createInProcessServer(
  world: InMemoryWorld,
  agentRunner: AgentRunner,
  profileStore: ProfileStore = createInMemoryProfileStore(world),
)
```

Так старые specs не ломаются.

---

## 11. SDK validation

Файл: `src/client/sdk/minutka-client.ts`.

Добавить Zod schemas:

- `openInviteRequest`
- `openInviteResponse`
- `acceptConsentRequest`
- `acceptConsentResponse`
- `completeOnboardingRequest`
- `completeOnboardingResponse`
- `getProfileRequest`
- `profileResponse`

Пример CLI-oriented API:

```ts
await client.openInvite({ inviteCode: "invite_test_1", employeeId: "emp_test_1" });
await client.acceptConsent({ employeeId: "emp_test_1", accepted: true, source: "cli" });
await client.completeOnboarding({
  employeeId: "emp_test_1",
  role: "Руководитель проектов",
  typicalTasks: ["встречи", "отчёты", "координация подрядчиков"],
  persona: "efficiency",
  aiLevel: "intermediate",
  responseLength: "short",
});
```

SDK должен бросать валидационные ошибки до попадания в application layer.

---

## 12. CLI команды

Файл: `src/client/cli/minutka-cli.ts`.

Сохранить существующую команду:

```bash
employee chat --employee emp_test_1 --thread thread_test_1 --text "..."
```

Добавить commands под `employee`:

### 12.1 `employee open-invite`

```bash
employee open-invite \
  --invite invite_test_1 \
  --employee emp_test_1
```

Вывод JSON:

```json
{
  "employeeId": "emp_test_1",
  "inviteCode": "invite_test_1",
  "status": "invite_opened",
  "privacyVersion": "privacy-v1",
  "privacyExplanation": "..."
}
```

### 12.2 `employee accept-consent`

```bash
employee accept-consent \
  --employee emp_test_1 \
  --yes
```

`--yes` обязателен, чтобы consent не принимался неявно.

Вывод JSON:

```json
{
  "employeeId": "emp_test_1",
  "privacyVersion": "privacy-v1",
  "acceptedAt": "2026-07-08T10:00:00.000Z"
}
```

### 12.3 `employee complete-onboarding`

```bash
employee complete-onboarding \
  --employee emp_test_1 \
  --role "Руководитель проектов" \
  --task "встречи" \
  --task "отчёты" \
  --persona efficiency \
  --ai-level intermediate \
  --response-length short
```

Commander должен поддержать repeated option `--task`.

Вывод JSON:

```json
{
  "employeeId": "emp_test_1",
  "status": "profile_completed",
  "profile": { "...": "..." },
  "firstResponse": "..."
}
```

### 12.4 `employee profile`

```bash
employee profile --employee emp_test_1
```

Нужна для проверки сохранения профиля и будущей Telegram personal area.

---

## 13. Executable spec

Новый файл:

`specs/executable/onboarding/SPEC-ONBOARDING-001.spec.ts`

### 13.1 Metadata

```ts
registerSpecMetadata({
  id: "SPEC-ONBOARDING-001",
  userStory: "US-ONBOARDING-001",
  requirements: ["FR-ONBOARDING-001", "FR-CONSENT-001", "FR-PROFILE-001"],
  productParts: [
    "telegram-bot-shell",
    "ai-agent-backend-runtime",
    "data-storage-and-privacy-layer",
  ],
  contracts: ["openInvite", "acceptConsent", "completeOnboarding", "profile", "chat"],
  events: [
    "InviteOpened",
    "PrivacyExplanationShown",
    "ConsentAccepted",
    "UserProfileUpdated",
    "OnboardingCompleted",
    "ChatMessageReceived",
    "ChatResponseGenerated",
  ],
  mastra: ["minutkaAgent", "updateProfileTool"],
  cli: [
    "employee open-invite",
    "employee accept-consent",
    "employee complete-onboarding",
    "employee profile",
    "employee chat",
  ],
});
```

### 13.2 Основной сценарий

Given:

- новый участник с invite `invite_test_1`;
- профиля и consent ещё нет;
- mock-agent runner сохраняет полученный `context` в массив наблюдений.

When:

1. CLI `employee open-invite`.
2. CLI `employee accept-consent --yes`.
3. CLI `employee complete-onboarding` с persona `efficiency`.
4. CLI `employee profile`.
5. CLI `employee chat` с первым рабочим сообщением.

Then:

- `privacyExplanation` содержит правило про обезличенные агрегаты и минимум 5 сотрудников;
- consent сохранён с `privacy-v1`;
- profile сохранён с `persona = "efficiency"`, `aiLevel = "intermediate"`, role и tasks;
- `firstResponse` существует;
- mock-runner видел `context.systemContext`, где есть:
  - `Выбранная персона: Эффективность` или эквивалент;
  - роль;
  - AI level;
  - rule про практичный/структурный тон;
- последующий `chat` тоже получает profile context;
- события onboarding и chat эмитнуты;
- повторный `open-invite` для того же invite не создаёт второго participant и возвращает текущий статус;
- повторный `accept-consent --yes` не создаёт второй consent, не меняет `acceptedAt` и не эмитит повторный `ConsentAccepted`.

### 13.3 Negative specs внутри того же файла

1. Нельзя завершить onboarding без consent:

```bash
employee complete-onboarding --employee emp_no_consent ...
```

Ожидание: ошибка содержит `consent`.

2. Нельзя выбрать неизвестную persona:

```bash
--persona harsh
```

Ожидание: SDK/CLI validation error.

3. Нельзя принять consent без `--yes`:

```bash
employee accept-consent --employee emp_test_1
```

Ожидание: CLI error.

4. Нельзя переоткрыть занятый invite с другим employeeId:

```bash
employee open-invite --invite invite_test_1 --employee emp_other
```

Ожидание: ошибка содержит `invite already belongs to another employee`.

5. Повторный consent идемпотентен:

```bash
employee accept-consent --employee emp_test_1 --yes
employee accept-consent --employee emp_test_1 --yes
```

Ожидание: второй вызов возвращает тот же `acceptedAt`, не создаёт дубль consent и не эмитит второй `ConsentAccepted`.

### 13.4 Harness changes

`SpecWorld` сейчас содержит только `cli`. Для Phase 2 нужно уметь проверять world/profile/agent observations.

Минимальное изменение:

```ts
export type SpecWorld = {
  cli: CliDriver;
  world: InMemoryWorld;
};
```

`createSpecWorld` должен вернуть `world`, чтобы specs могли проверять:

```ts
expect(spec.world.profiles).toContainEqual(expect.objectContaining(...));
```

Также полезно добавить helper:

```ts
export function expectProfile(spec: SpecWorld, employeeId: string, expected: Partial<UserProfile>)
```

Нужно убедиться, что `SPEC-SKELETON-001` не ломается от дополнительного поля.

---

## 14. Обновление fixtures

Файл: `specs/executable/support/fixtures.ts`.

Добавить:

```ts
export const testInvite = {
  inviteCode: "invite_test_1",
};

export const testProfile = {
  role: "Руководитель проектов",
  typicalTasks: ["встречи", "отчёты", "координация подрядчиков"],
  persona: "efficiency" as const,
  aiLevel: "intermediate" as const,
  responseLength: "short" as const,
};
```

---

## 15. Изменения по файлам

Итоговая ожидаемая структура после этапа:

```text
src/
├── domain/
│   ├── employee.ts                    # Persona, AiLevel, Participant, Consent, UserProfile
│   ├── events.ts                      # + onboarding events
│   └── privacy.ts                     # currentPrivacyVersion, privacyExplanation
├── application/
│   ├── in-memory-world.ts             # + participants, consents, profiles
│   ├── profile-store.ts               # ProfileStore interface
│   ├── in-memory-profile-store.ts     # adapter over InMemoryWorld
│   ├── minutka-context-builder.ts     # dynamic profile/persona context
│   └── minutka-service.ts             # + onboarding use cases, chat with profile context
├── server/
│   └── http/
│       └── in-process-server.ts       # + onboarding API methods
├── client/
│   ├── sdk/
│   │   └── minutka-client.ts          # + onboarding methods and schemas
│   └── cli/
│       └── minutka-cli.ts             # + onboarding commands
└── mastra/
    ├── agent-runner.ts                # passes systemContext into Agent.generate
    ├── agents/
    │   └── minutka-agent.ts           # optional tools + updated instructions
    └── tools/
        ├── index.ts                   # export updateProfileTool
        └── update-profile-tool.ts     # Mastra createTool

specs/executable/
├── support/
│   ├── fixtures.ts                    # + invite/profile fixtures
│   ├── spec-harness.ts                # expose world/profile helpers
│   └── cli-driver.ts                  # unchanged unless server signature changes
├── skeleton/
│   └── SPEC-SKELETON-001.spec.ts      # should remain green
└── onboarding/
    └── SPEC-ONBOARDING-001.spec.ts    # new
```

---

## 16. Порядок реализации

| # | Действие | Проверка |
|---|---|---|
| 1 | Создать ветку/убедиться, что старт от `phase-1-skeleton` | `git status`, `git tag --list` |
| 2 | Прочитать Mastra embedded docs по `Agent.generate()` и `createTool()` | `read node_modules/@mastra/core/dist/docs/...` |
| 3 | Расширить domain: employee/privacy/events | `npm run typecheck` |
| 4 | Расширить `InMemoryWorld`; добавить `ProfileStore` и in-memory adapter | `npm run typecheck` |
| 5 | Добавить context builder с persona/AI-level правилами | `npm run typecheck` |
| 6 | Расширить `AgentRunner` context-aware сигнатурой и runtime bridge | `npm run typecheck` |
| 7 | Реализовать onboarding use cases в application service | `npm run typecheck` |
| 8 | Расширить in-process server | `npm run typecheck` |
| 9 | Расширить SDK Zod schemas/methods | `npm run typecheck` |
| 10 | Добавить CLI commands | `npm run typecheck` |
| 11 | Добавить `updateProfileTool` и экспорт из tools | `npm run typecheck` |
| 12 | Обновить spec harness/fixtures | `npm run typecheck` |
| 13 | Написать `SPEC-ONBOARDING-001` красной/зелёной итерацией | `npm run specs -- SPEC-ONBOARDING-001` или `npm run specs` |
| 14 | Прогнать все specs | `npm run specs` |
| 15 | Полная проверка | `npm run verify && nix run .#verify` |
| 16 | Коммит и тег | `git add . && git commit -m "Implement phase 2 onboarding" && git tag phase-2-onboarding` |

---

## 17. Детальный сценарий `SPEC-ONBOARDING-001`

Псевдокод:

```ts
describe("SPEC-ONBOARDING-001", () => {
  it("onboards employee with consent, profile and efficiency persona context", async () => {
    const observedRuns: Array<{ input: ChatInput; context?: AgentRunContext }> = [];
    const mockAgentRunner: AgentRunner = async (input, context) => {
      observedRuns.push({ input, context });
      if (context?.systemContext?.includes("Эффективность")) {
        return "Принято. Зафиксировал роль и задачи. Начнём с главного приоритета на сегодня.";
      }
      return "Принято.";
    };

    const spec = createSpecWorld(mockAgentRunner);

    const invite = await spec.cli.json<OpenInviteResult>([
      "employee", "open-invite",
      "--invite", testInvite.inviteCode,
      "--employee", testEmployee.employeeId,
    ]);

    expect(invite.privacyExplanation).toContain("обезлич");
    expect(invite.privacyExplanation).toContain("5 сотрудников");

    await spec.cli.json([
      "employee", "accept-consent",
      "--employee", testEmployee.employeeId,
      "--yes",
    ]);

    const onboarding = await spec.cli.json<CompleteOnboardingResult>([
      "employee", "complete-onboarding",
      "--employee", testEmployee.employeeId,
      "--role", testProfile.role,
      "--task", "встречи",
      "--task", "отчёты",
      "--task", "координация подрядчиков",
      "--persona", "efficiency",
      "--ai-level", "intermediate",
      "--response-length", "short",
    ]);

    expect(onboarding.profile.persona).toBe("efficiency");
    expect(onboarding.firstResponse).toContain("приоритет");

    const profile = await spec.cli.json<UserProfile>([
      "employee", "profile",
      "--employee", testEmployee.employeeId,
    ]);

    expect(profile.role).toBe(testProfile.role);

    await spec.cli.json([
      "employee", "chat",
      "--employee", testEmployee.employeeId,
      "--thread", testEmployee.threadId,
      "--text", "Сегодня хочу закрыть отчёт и не утонуть во встречах.",
    ]);

    expect(observedRuns.some((run) =>
      run.context?.systemContext?.includes("Эффективность") &&
      run.context.systemContext.includes(testProfile.role)
    )).toBe(true);

    expectEvent(spec, [
      { type: "InviteOpened", employeeId: testEmployee.employeeId },
      { type: "PrivacyExplanationShown", employeeId: testEmployee.employeeId },
      { type: "ConsentAccepted", employeeId: testEmployee.employeeId },
      { type: "UserProfileUpdated", employeeId: testEmployee.employeeId },
      { type: "OnboardingCompleted", employeeId: testEmployee.employeeId },
      { type: "ChatMessageReceived", employeeId: testEmployee.employeeId },
      { type: "ChatResponseGenerated", employeeId: testEmployee.employeeId },
    ]);
  });
});
```

---

## 18. Backward compatibility с Phase 1

Чтобы `SPEC-SKELETON-001` осталась зелёной:

1. Не менять CLI `employee chat` arguments.
2. Не требовать профиль/consent для `chat()` в Phase 2.
3. Не требовать `OPENAI_API_KEY` для specs.
4. Не менять JSON response `chat`: `{ messageId, response }`.
5. `createSpecWorld(async () => "ok")` должен продолжить работать.
6. `createInProcessServer(world, agentRunner)` должен продолжить работать.

---

## 19. Privacy acceptance criteria

Phase 2 должна закрепить базовые privacy rules структурно:

- `privacyExplanation` явно говорит, что компания не получает личные диалоги.
- `privacyExplanation` явно говорит про обезличенные агрегаты.
- `privacyExplanation` явно говорит про минимум 5 сотрудников для агрегированной аналитики.
- `ConsentAccepted` хранит `privacyVersion`.
- `employeeId` в specs выглядит как псевдоним (`emp_test_1`), а не ФИО/Telegram ID.
- Profile не содержит имени, ФИО, Telegram username или chat id.
- Chat не запрещён без профиля на Phase 2 ради backward compatibility, но onboarding completion без consent запрещён.

---

## 20. Ошибки и сообщения

Минимальные application errors:

| Ситуация | Ошибка |
|---|---|
| Open invite с inviteCode, уже привязанным к другому employeeId | `invite already belongs to another employee` |
| Complete onboarding без participant | `participant not found` |
| Complete onboarding без consent | `consent is required before onboarding can be completed` |
| Accept consent без participant | `participant not found` |
| `accepted !== true` | `privacy consent must be explicitly accepted` |
| Empty role | SDK validation error |
| Empty tasks | SDK validation error |
| Unknown persona | SDK/commander validation error |
| Profile not found | `profile not found` |

Для MVP достаточно `throw new Error(...)`; отдельные error classes можно отложить.

---

## 21. Команды ручной проверки

После реализации:

```bash
npm run typecheck
npm run specs
npm run verify
nix run .#verify
```

Ручной CLI smoke, если будет добавлен executable entrypoint позднее, не обязателен. Основной интерфейс пока тестируется через `runMinutkaCli()` в specs.

---

## 22. Риски и митигация

| Риск | Вероятность | Митигация |
|---|---:|---|
| Mastra `createTool` / `Agent.generate` API отличается от ожиданий | Средняя | Перед кодом читать embedded docs установленной версии; если typecheck падает — сверяться с `node_modules/@mastra/core/dist/docs` и type definitions |
| Tool начнёт тащить business logic в Mastra слой | Средняя | Главный updater держать в application; tool — тонкая оболочка или smoke primitive |
| Онбординг станет LLM-зависимым и flaky | Средняя | Consent/profile сохранять детерминированно; LLM только для firstResponse через mock runner в specs |
| Сломается `SPEC-SKELETON-001` | Низкая | Сохранить старые сигнатуры через optional deps/defaults; chat не требует profile |
| Privacy text станет слишком юридическим/длинным | Низкая | Держать короткий `privacyExplanation`, юридический текст отложить |
| Рано выбрать не тот storage | Средняя | В Phase 2 только interface + in-memory adapter; SQLite/libSQL отдельным решением после Phase 3 memory needs |

---

## 23. Ориентировочное время

| Блок | Время |
|---|---:|
| Domain/privacy/events | 20 мин |
| Storage interface + in-memory adapter | 25 мин |
| Context builder + AgentRunner context | 25 мин |
| Application use cases | 45 мин |
| Server + SDK | 35 мин |
| CLI commands | 35 мин |
| Mastra updateProfileTool | 20 мин |
| Spec harness + fixtures | 20 мин |
| `SPEC-ONBOARDING-001` | 45 мин |
| Verify/fixes | 30 мин |
| Commit/tag | 10 мин |
| **Итого** | **≈ 5 часов** |

---

## 24. Итог этапа

После Phase 2 проект должен иметь устойчивый onboarding foundation:

- есть согласие и версия privacy explanation;
- есть профиль сотрудника с persona/AI level;
- persona реально попадает в контекст агента;
- application surface готова для Telegram Phase 4;
- storage boundary готова для persistence/Mastra Memory следующих этапов;
- все пользовательские действия проверены executable spec без внешних API.
