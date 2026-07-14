# Этап 5: Голосовые сообщения и STT boundary

> **Родительский план:** [time-agent-mastra-plan.md](./time-agent-mastra-plan.md)
> **Предыдущий этап:** [phase-4.2-http-application-api.md](./phase-4.2-http-application-api.md)
> **Стартовый тег:** `phase-4.2-http-application-api`
> **Целевой тег:** `phase-5-voice-stt`

---

## 1. Цель этапа

Сотрудник отправляет голосовое сообщение в Telegram, бот транскрибирует его через STT boundary и обрабатывает транскрипт **тем же chat/use-case путём, что и обычный текст**: тот же `client.chat()`, тот же Agent Vault decision plane, те же feedback-кнопки. Исходное voice-событие связано с сохранённым сообщением через privacy-safe `inputModality` без утечки transport metadata.

Технологическое решение: используем **встроенные voice-возможности Mastra** — провайдер `@mastra/voice-openai` (`OpenAIVoice.listen()`) с OpenAI как STT-провайдером (модель `whisper-1`). Провайдер оборачивается в собственный application-level порт, чтобы specs и остальные слои не зависели от Mastra/OpenAI напрямую.

Принципы этапа:

- **простой:** нет TTS/`speak()`, нет realtime/streaming STT, нет хранения аудио, нет конвертации форматов (Telegram OGG/Opus напрямую поддерживается Whisper API);
- **надёжный:** specs используют fake STT и fake file gateway; реальный OpenAI/Telegram нужен только для manual smoke; ошибки STT дают controlled user-facing fallback;
- **эффективный:** voice конвергирует с text в одну внутреннюю функцию shell; guards (session, consent, in-flight, лимиты) срабатывают **до** скачивания файла и вызова STT.

---

## 2. Definition of Done

- [ ] Добавлена dependency `@mastra/voice-openai`; API `OpenAIVoice`/`listen()` сверен с embedded docs установленной версии.
- [ ] Добавлен application-level порт `SpeechToTextPort`; Mastra-реализация живёт в `src/mastra/`.
- [ ] STT настраивается отдельно через `STT_PROVIDER`, `STT_API_KEY` и необязательный `STT_BASE_URL`; STT-трафик не наследует `OPENAI_API_KEY` или `OPENAI_BASE_URL` LLM-контура. Без `STT_API_KEY` polling-бот продолжает запускаться, но controlled-ответом отключает voice.
- [ ] Добавлен `TelegramVoiceFileGateway` (download boundary) в Telegram shell слое; Telegraf-реализация через `getFileLink` + `fetch`.
- [ ] `createTelegramShell()` получил `handleVoice()`: metadata guards → download → STT → общий chat-путь.
- [ ] Voice и text сходятся в один внутренний dispatch: после транскрипции bot сначала показывает сотруднику `Распознано:\n<transcript>`, затем voice проходит ровно тот же путь, что `handleText` (включая onboarding-ответы голосом до создания профиля).
- [ ] Chat contract расширен опциональным `inputModality: "text" | "voice"` (default `"text"`); поле проходит SDK → HTTP `/v1` → `MinutkaService.chat()`.
- [ ] `ChatMessageReceived` и audit `chat_received` содержат `inputModality`; никакие Telegram `fileId`/URL/duration в domain events не попадают.
- [ ] Guards: длительность ≤ 300 сек, размер ≤ 20 MB (лимит Telegram `getFile`), пустой транскрипт → controlled message без вызова `chat()`.
- [ ] `SPEC-VOICE-001` проходит через telegram-driver с fake STT/gateway, без OpenAI key, Telegram token и network.
- [ ] Предыдущие specs остаются зелёными.
- [ ] `npm run typecheck`, `npm run specs`, `npm run verify`, `nix run .#verify` проходят.
- [ ] Ручной Telegram voice smoke: реальное голосовое сообщение → осмысленный ответ агента с feedback-кнопками.
- [ ] Коммит и тег `phase-5-voice-stt`.

---

## 3. Границы этапа

### Входит

1. `SpeechToTextPort` + Mastra/OpenAI реализация (`whisper-1`).
2. `TelegramVoiceFileGateway` + Telegraf-реализация скачивания voice-файла.
3. `handleVoice()` в pure Telegram shell + `bot.on("voice")` в Telegraf runtime.
4. `inputModality` в chat contract, domain event и audit metadata.
5. Расширение telegram-driver (`sendVoice`) и `SPEC-VOICE-001`.
6. Отдельная runtime-конфигурация STT: `STT_PROVIDER` (сейчас только `openai`), обязательный для voice `STT_API_KEY`, необязательный `STT_BASE_URL`.
7. Обновление privacy-заметок в `vault/docs/privacy-boundary.md` (аудио обрабатывается настроенным внешним STT-провайдером, не хранится).
8. Ручной smoke с реальным ботом и OpenAI.

### Не входит

- TTS / голосовые ответы бота (`voice.speak()`).
- Realtime/streaming STT (`OpenAIRealtimeVoice`, события `writing`).
- Хранение аудиофайлов, audio blob store, повторная транскрипция.
- Конвертация аудиоформатов (ffmpeg): Telegram voice = OGG/Opus, Whisper принимает `ogg` напрямую.
- Поддержка `audio`-документов, `video_note`, пересланных файлов — только `message.voice`.
- Feedback голосом, voice-специфичные процессы в Agent Vault: транскрипт — обычный user text, routing не меняется.
- Отдельная PostgreSQL-миграция: `inputModality` фиксируется в событии/audit metadata (jsonb), схема conversation не меняется.
- Env-конфигурация STT-модели: константа `whisper-1`; выбор модели — отдельным решением при реальной необходимости. Runtime credentials и endpoint — исключение: они задаются отдельными `STT_PROVIDER` / `STT_API_KEY` / `STT_BASE_URL`.

---

## 4. Архитектурное решение

### 4.1 Где живёт STT

STT — это **transport-adjacent boundary**, а не application use case: аудио существует только между Telegram и транскриптом. Поэтому:

```text
Telegram voice update
  → Telegraf runtime adapter (metadata: fileId, duration, size)
  → pure telegram-shell.handleVoice()
      guards (session, consent, in-flight, duration/size)
  → TelegramVoiceFileGateway.openVoiceFile(fileId)   # download boundary
  → SpeechToTextPort.transcribe(stream)              # Mastra OpenAIVoice.listen()
  → общий dispatch: тот же путь, что handleText(transcript)
  → client.chat({ threadId, text: transcript, inputModality: "voice" })
  → HTTP /v1 → MinutkaService.chat() → Agent Vault routing → AgentRunner
```

Следствия:

- HTTP API `/v1` остаётся текстовым: по нему идёт только транскрипт. Никаких multipart/audio endpoints.
- Аудиобайты живут только в памяти процесса бота на время одного update; ничего не пишется на диск и в storage.
- `MinutkaService` не знает про Telegram, файлы и OpenAI Audio — он видит text + coarse-grained `inputModality`.

Альтернатива «подключить voice к `minutkaAgent` через `agent.voice.listen()`» отклонена: STT нужен **до** decision router (транскрипт участвует в routing), а specs мокируют границу на уровне порта, а не Mastra Agent.

### 4.2 Порты

```ts
// src/application/speech-to-text.ts — интерфейс на нейтральном слое,
// его импортируют и src/mastra (реализация), и src/telegram (потребитель).
export type SpeechToTextInput = {
  audio: NodeJS.ReadableStream;
  /** Формат контейнера для STT-провайдера, например "ogg". */
  filetype: string;
};

export interface SpeechToTextPort {
  /** Возвращает plain-text транскрипт; бросает controlled error при сбое провайдера. */
  transcribe(input: SpeechToTextInput): Promise<string>;
}
```

```ts
// src/telegram/telegram-voice-file-gateway.ts — download boundary.
export type TelegramVoiceFile = {
  stream: NodeJS.ReadableStream;
  filetype: string; // для Telegram voice всегда "ogg"
};

export interface TelegramVoiceFileGateway {
  openVoiceFile(fileId: string): Promise<TelegramVoiceFile>;
}
```

`fileId` и file URL — transport identifiers: они допустимы только в shell/gateway и transient-логах; не попадают в application contract, domain events, audit и insights.

### 4.3 Конфигурация и Mastra-реализация STT

STT — самостоятельный credential boundary. LLM использует `OPENAI_API_KEY`/`OPENAI_BASE_URL`; voice использует только:

```dotenv
STT_PROVIDER=openai                 # default; единственный поддержанный сейчас
STT_API_KEY=                        # включает voice-транскрипцию
# STT_BASE_URL=https://api.openai.com/v1  # optional OpenAI-compatible endpoint
```

`STT_API_KEY` пустой означает, что polling-бот остаётся совместим с существующим текстовым deployment: voice handler отвечает, что голос временно недоступен, и не скачивает файл. Если задан любой из остальных STT-параметров без ключа, или выбран неподдерживаемый provider, запуск завершается с понятной configuration error.

```ts
// src/mastra/voice-transcriber.ts
const options = { baseURL: config.baseUrl ?? "https://api.openai.com/v1" };
const voice = new OpenAIVoice({
  // Текущая версия пакета создаёт оба клиента даже при listen()-only.
  // Оба получают только STT credentials и явный endpoint.
  speechModel: { name: "tts-1", apiKey: config.apiKey, options },
  listeningModel: { name: "whisper-1", apiKey: config.apiKey, options },
});
```

Явный fallback `https://api.openai.com/v1` и ключи в обеих model-конфигурациях обязательны: `openai` SDK иначе читает `OPENAI_BASE_URL`/`OPENAI_API_KEY` из окружения, а `OpenAIVoice` текущей версии требует speech key, хотя TTS не используется. Таким образом аудио не может случайно уйти через LLM proxy.

Docs-first обязательства перед реализацией (правило №3 родительского плана):

1. После `npm install @mastra/voice-openai` прочитать embedded docs/типы установленной версии (`node_modules/@mastra/voice-openai`), сверить сигнатуру конструктора (`listeningModel`, `speechModel`), `listen(stream, { filetype })` и тип возврата.
2. Проверить peer-совместимость с `@mastra/core@1.50.x` и исходники конструктора: он создаёт speech и listening clients; не полагаться на env fallback SDK.
3. `whisper-1` — не chat-модель, provider registry для неё не применяется; фиксация модели — в этом плане и в коде константой.

Формат: Telegram voice — OGG/Opus; официальный список Whisper API включает `ogg`, поэтому конвертация не нужна.

### 4.4 Telegraf download gateway

```ts
// внутри serve.ts composition root (по образцу replyPort)
import { Readable } from "node:stream";

const voiceFileGateway: TelegramVoiceFileGateway = {
  async openVoiceFile(fileId) {
    if (!activeBot) throw new Error("Bot not running");
    const url = await activeBot.telegram.getFileLink(fileId);
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`Voice file download failed (${response.status})`);
    return { stream: Readable.fromWeb(response.body), filetype: "ogg" };
  },
};
```

Замечания:

- URL из `getFileLink` содержит bot token в пути — **не логировать** URL и тела ошибок fetch целиком; в логах только operation + error name (существующий паттерн `logShellError`).
- Bot API `getFile` отдаёт файлы до 20 MB — это естественный верхний лимит; проверка размера по `voice.file_size` делается до скачивания. Если Telegram не передал размер, ограничивающий stream всё равно обрывает загрузку после 20 MiB.
- Поток закрывается в `finally`, включая случай, когда STT-провайдер завершился ошибкой до полного чтения body.

### 4.5 `handleVoice` в pure shell

Извлечь из `handleText` общий внутренний dispatch (session → consent → profile/onboarding → chat → feedback-кнопки → отправка chunks), после чего:

```text
handleVoice(chatId, voice: { fileId, durationSeconds, fileSizeBytes? }, userId?)
  1. in-flight guard по chatId (общий с text)
  2. session + consent guards — как в handleText, ДО скачивания файла
  3. if durationSeconds > 300 → "Голосовое сообщение слишком длинное (максимум 5 минут)."
  4. if fileSizeBytes > 20 MB → controlled message (лимит Telegram)
  5. под typing indicator: gateway.openVoiceFile(fileId) → speechToText.transcribe(); закрыть stream в `finally`; если size отсутствует, применить stream-limit 20 MiB
  6. transcript.trim(); пустой → "Не удалось распознать голосовое сообщение. Попробуйте ещё раз или напишите текстом."
  7. transcript длиннее 4096 chars → тот же лимит, что у текста
  8. отправить в Telegram `Распознано:\n<transcript>` (с обычным chunking по 4 000 символов) reply к исходному voice `message_id`; если доставка не удалась, не отправлять невидимый сотруднику текст в onboarding/chat
  9. дальше — общий dispatch с inputModality = "voice":
     - профиль не создан → submitOnboardingAnswer({ text: transcript })  (onboarding голосом работает бесплатно)
     - профиль есть → chat({ threadId, text: transcript, inputModality: "voice" }) → ответ с feedback-кнопками
  10. любая ошибка download/STT/показа транскрипта → logShellError + "Не удалось обработать голосовое сообщение. Попробуйте ещё раз позже."
```

`createTelegramShell()` получает optional `speechToText` и `voiceFileGateway`: в polling deployment без STT key text остаётся доступен, а voice получает controlled fallback без download. При заданном STT key обе зависимости передаются вместе.

### 4.6 Telegraf runtime

```ts
bot.on("voice", async (ctx) => {
  // private-chat guard как у text
  const voice = ctx.message.voice; // { file_id, duration, file_size?, mime_type? }
  await shell.handleVoice(String(ctx.chat.id), {
    fileId: voice.file_id,
    durationSeconds: voice.duration,
    fileSizeBytes: voice.file_size,
  }, ctx.from ? String(ctx.from.id) : undefined);
});
```

Сверить актуальный способ подписки в установленном Telegraf 4.16 (`bot.on("voice", ...)` vs `bot.on(message("voice"), ...)`) — выбрать тот же стиль, что текущий `bot.on("text")`, чтобы не смешивать API.

---

## 5. Contract и domain изменения: `inputModality`

`SPEC-VOICE-001` требует связать voice-событие с сообщением. Делается минимально, без transport metadata и без миграции:

1. **Contract** (`src/contracts/minutka-api.ts`):

```ts
export const chatInputModalitySchema = z.enum(["text", "voice"]);
export const chatRequestSchema = z.strictObject({
  threadId: threadIdSchema,
  text: z.string().min(1).max(60_000),
  inputModality: chatInputModalitySchema.optional(), // default "text" на service-стороне
});
```

2. **Domain event** (`src/domain/events.ts`): `ChatMessageReceived` получает `inputModality: "text" | "voice"`.
3. **Audit** (`src/application/audit-event-store.ts`): `chat_received` allow-list расширяется ключом `inputModality`; audit record уже содержит `messageId` — это и есть privacy-safe связь «voice-событие ↔ сообщение».
4. **Service** (`src/application/minutka-service.ts`): `chat()` принимает `inputModality` (default `"text"`), кладёт его в событие и audit metadata. Routing, decision plane и insight extraction **не** меняются: транскрипт — обычный текст.
5. **SDK/CLI**: `ServiceMinutkaClient.chat()` пробрасывает поле; CLI может получить опциональный флаг `--input-modality` только если он нужен для отладки — иначе не добавлять.

Что запрещено: `fileId`, file URL, `mimeType`, длительность и размер файла в contract/domain/audit. Единственное privacy-safe поле — enum `inputModality` (по аналогии с `source` у feedback).

`ConversationTurn` и таблица conversation не расширяются: транскрипт уже сохраняется как обычный private `user_text` в canonical conversation history, потому что он передаётся в обычный `chat()` use case. Audit `chat_received(messageId, inputModality)` связывает этот turn с voice без дублирования raw transcript в audit. Если позже аналитике понадобится модальность непосредственно в history — отдельная миграция отдельным решением.

---

## 6. Executable spec: `SPEC-VOICE-001`

### 6.1 Metadata

Product parts: `telegram-bot-shell`, `ai-agent-backend-runtime`, `data-storage-and-privacy-layer`.
Contracts: `telegram-shell`, `speech-to-text`, `chat`.
Events: `ChatMessageReceived`, `ChatResponseGenerated`.

### 6.2 Test harness

Расширить `specs/executable/support/telegram-driver.ts`:

```ts
await telegram.sendVoice({ chatId, userId, fileId, durationSeconds, fileSizeBytes });
```

Driver собирает shell с fake-портами:

- **fake `TelegramVoiceFileGateway`**: словарь `fileId → аудио-заглушка` (Readable из Buffer); фиксирует вызовы для ассертов «guard сработал до download»;
- **fake `SpeechToTextPort`**: scripted `fileId/поток → транскрипт` или scripted error/пустая строка; фиксирует вызовы.

Реальные Whisper/OpenAI/Telegram/network не используются.

### 6.3 Given/When/Then

```text
Given сотрудник прошёл onboarding и связан с Telegram chat
When он отправляет voice message
Then shell скачивает файл через gateway и получает транскрипт через SpeechToTextPort
And bot сначала показывает `Распознано:\n<transcript>` reply к исходному voice message, чтобы сотрудник видел текст, отправляемый агенту
And транскрипт проходит тот же client.chat() путь, что и текст и сохраняется как private `user_text`
And бот отвечает с кнопками 👍/👌/👎, feedback по ответу работает как для текста
And ChatMessageReceived содержит text = транскрипт и inputModality = "voice"
And audit chat_received содержит messageId и inputModality = "voice"
And ни одно domain event / audit record не содержит fileId, URL, duration или file size
```

### 6.4 Обязательные edge checks

1. Happy path выше, включая последующий feedback callback на voice-ответ.
2. Text path регрессии: обычный текст даёт `inputModality = "text"` (или default) — voice не ломает text.
3. Нет session / нет consent → тот же controlled ответ, что у text; **gateway и STT не вызываются** (включая проверку текста ответа).
4. `durationSeconds > 300` → controlled message, gateway/STT не вызываются.
5. `fileSizeBytes > 20 MB` → controlled message, gateway/STT не вызываются; при отсутствующем `fileSizeBytes` stream-limit прекращает чтение после 20 MiB.
6. STT бросает ошибку → user-facing fallback, `client.chat()` не вызывается, shell не падает, stream закрыт.
7. Download gateway бросает ошибку → то же самое.
8. Пустой/whitespace транскрипт → controlled message «не удалось распознать», `chat()` не вызывается.
9. Транскрипт длиннее 4096 символов → тот же лимит, что у текста.
10. In-flight guard: второй voice (или text) по тому же chatId во время обработки → cooldown message, без параллельного STT/LLM.
11. Voice до создания профиля → транскрипт уходит в `submitOnboardingAnswer` (onboarding голосом), профиль не создаётся мимо confirm-flow.

---

## 7. Последовательность реализации

### Step 0 — Pre-flight

```bash
npm run typecheck && npm run specs
```

Зафиксировать зелёный baseline от `phase-4.2-http-application-api`.

### Step 1 — Dependency и docs-first проверка

1. `npm install @mastra/voice-openai` (проверить последнюю версию и peer-совместимость с `@mastra/core@1.50.x`).
2. Прочитать embedded docs/`.d.ts` установленного пакета: конструктор, `listen()`, тип возврата, обработка `OPENAI_API_KEY`/`OPENAI_BASE_URL`.
3. `npm run typecheck` — убедиться, что установка не сломала baseline (включая Nix: `nix run .#verify`).

### Step 2 — Contract/domain `inputModality`

Атомарно: `src/contracts/minutka-api.ts`, `src/domain/events.ts`, `src/application/audit-event-store.ts` (allow-list), `src/application/minutka-service.ts`, `src/client/sdk/minutka-client.ts`, HTTP router/in-process server (если типы не протекают автоматически). Обновить существующие specs, которые strict-сравнивают `ChatMessageReceived`.

Проверка: `npm run typecheck && npm run specs`.

### Step 3 — Порты и Mastra STT adapter

1. `src/application/speech-to-text.ts` — интерфейс.
2. `src/runtime/stt-config.ts` — parse/validation `STT_PROVIDER`, `STT_API_KEY`, `STT_BASE_URL`; отсутствие ключа отключает только voice.
3. `src/mastra/voice-transcriber.ts` — `createOpenAiSpeechToText()` с явно заданными STT key/base URL у listening и обязательного внутреннего speech client.
4. `src/telegram/telegram-voice-file-gateway.ts` — интерфейс gateway.

Проверка: `npm run typecheck`.

### Step 4 — Shell `handleVoice` + общий dispatch

1. Рефакторинг `handleText`: выделить общий внутренний dispatch (guards + onboarding + chat + кнопки) без изменения поведения.
2. Добавить `handleVoice` по разделу 4.5; лимиты — именованные константы (`maxVoiceDurationSeconds = 300`, `maxVoiceFileSizeBytes = 20 * 1024 * 1024`).
3. Обновить все точки сборки shell на новые deps.

Проверка: `npm run typecheck && npm run specs` (Phase 4 specs остаются зелёными).

### Step 5 — Telegram driver и `SPEC-VOICE-001`

1. `telegram-driver.ts`: `sendVoice()` + fake gateway/STT с фиксацией вызовов.
2. `specs/executable/telegram/SPEC-VOICE-001.spec.ts` со всеми edge checks из 6.4.

Проверка: `npm run specs`.

### Step 6 — Telegraf runtime и composition root

1. `bot.on("voice", ...)` в `telegraf-runtime.ts` (private-chat guard, metadata → shell).
2. `serve.ts`: если STT configured, собрать `voiceFileGateway` (getFileLink + fetch + `Readable.fromWeb`) и `createOpenAiSpeechToText()`; иначе создать текстовый shell без STT. STT-порт создаётся один раз на процесс.
3. Обновить `.env.example` и `vault/docs/privacy-boundary.md`: STT credentials/endpoints независимы от LLM `OPENAI_*`; голосовые сообщения транскрибируются настроенным внешним STT-провайдером, аудио не сохраняется, транскрипт обрабатывается как обычный текст.

Проверка: `npm run typecheck`.

### Step 7 — Manual voice smoke

```bash
TELEGRAM_MODE=polling npm run serve   # с STT_API_KEY, TELEGRAM_BOT_TOKEN и PostgreSQL; OPENAI_API_KEY нужен отдельно для LLM
```

1. Отправить голосовое: «Сегодня хочу закрыть квартальный отчёт, но всё утро ушло на звонки».
2. Убедиться: typing indicator во время транскрипции, осмысленный ответ агента, feedback-кнопки, feedback сохраняется.
3. Отправить очень короткое/невнятное voice → корректный fallback.
4. Проверить в логах отсутствие file URL/token; в audit — `chat_received` с `inputModality = voice` и без transport-полей.

### Step 8 — Final verification

```bash
npm run typecheck && npm run specs && npm run verify
nix run .#verify
npm run verify:persistence   # регрессия: схема БД не менялась, но контур должен остаться зелёным
```

Коммит и тег `phase-5-voice-stt`.

---

## 8. Acceptance criteria

1. **Convergence:** voice после транскрипции проходит буквально тот же shell dispatch и `client.chat()`, что и текст; никакой voice-специфичной бизнес-логики в Application.
2. **Mastra built-in STT:** транскрипция — `OpenAIVoice.listen()` из `@mastra/voice-openai`, скрытая за `SpeechToTextPort`.
3. **Boundary:** аудио не пересекает HTTP API и не персистится; `MinutkaService` не импортирует ничего voice/Mastra-voice-специфичного.
4. **Linkage:** audit `chat_received` связывает `messageId` с `inputModality = "voice"`; `ChatMessageReceived` несёт модальность.
5. **Privacy:** `fileId`, file URL, duration, size, mimeType остаются в shell/gateway; в domain events, audit, insights и aggregates их нет; bot token не попадает в логи через file URL.
6. **No external deps in specs:** `SPEC-VOICE-001` зелёный без OpenAI key, Telegram token и network.
7. **Fail-controlled:** ошибки download/STT и пустые транскрипты дают понятные user-facing ответы и не роняют bot loop.
8. **Manual smoke:** реальный voice → реальный Whisper транскрипт → ответ агента.

---

## 9. Риски и решения

| Риск | Решение |
|---|---|
| API `@mastra/voice-openai` отличается от знаний/старых доков | Docs-first: читать embedded docs/типы установленной версии до кода (Step 1); typecheck как ранний детектор. |
| Версия voice-пакета несовместима с `@mastra/core@1.50.x` | Проверить peer deps при установке; при конфликте — зафиксировать совместимую пару версий или, как fallback, реализовать порт напрямую на `openai` SDK, не ломая `SpeechToTextPort`. |
| `voice.listen()` вернёт stream вместо string | Порт проверяет тип возврата и бросает controlled error; для whisper-1 ожидается `string`. |
| File URL с bot token утечёт в логи | Логировать только operation + error name (существующий `logShellError`); не логировать URL и raw fetch errors. |
| Дорогие/долгие транскрипции длинных voice | Лимит 300 сек и 20 MB до скачивания; in-flight guard по chatId уже ограничивает параллелизм. |
| Whisper вернёт мусор на шум/тишину | Пустой транскрипт → controlled message; мусорный, но непустой транскрипт идёт обычным путём — decision plane и guardrails обрабатывают его как любой текст. |
| Транскрипт «не то, что я сказал» подрывает доверие | Перед dispatch bot показывает сотруднику exact transcript с префиксом «Распознано:»; редактирование/повторная транскрипция остаются отдельной задачей. |
| `inputModality` начнут расширять transport-метаданными | Поле — закрытый enum по образцу feedback `source`; правило зафиксировано в разделе 5 и privacy-boundary doc. |
| STT случайно наследует LLM key или proxy из `OPENAI_*` | Никогда не полагаться на env fallback SDK: в оба клиента `OpenAIVoice` передаются `STT_API_KEY` и `STT_BASE_URL`, а при пустом `STT_BASE_URL` — явный официальный OpenAI URL. |
| Onboarding голосом усложнит FSM | Ничего не меняется: транскрипт уходит в существующий `submitOnboardingAnswer`, confirm остаётся кнопочным. |

---

## 10. Минимальный список файлов к изменению

```text
package.json                                   # + @mastra/voice-openai
src/contracts/minutka-api.ts                   # inputModality в chat request
src/domain/events.ts                           # ChatMessageReceived.inputModality
src/application/audit-event-store.ts           # chat_received allow-list
src/application/minutka-service.ts             # default "text", event/audit plumbing
src/application/speech-to-text.ts              # новый порт
src/client/sdk/minutka-client.ts               # проброс inputModality
src/mastra/voice-transcriber.ts                # OpenAIVoice adapter
src/telegram/telegram-voice-file-gateway.ts    # download boundary interface
src/telegram/telegram-shell.ts                 # handleVoice + общий dispatch
src/telegram/telegraf-runtime.ts               # bot.on("voice")
src/runtime/stt-config.ts                      # отдельные STT provider/credentials/endpoint
src/runtime/serve.ts                           # optional composition: gateway + STT port
.env.example                                   # отдельные STT variables и deployment note
vault/docs/privacy-boundary.md                 # заметка про внешний STT
specs/executable/support/telegram-driver.ts    # sendVoice + fake ports
specs/executable/telegram/SPEC-VOICE-001.spec.ts
```

Если какой-то файл окажется не нужен — не создавать его ради структуры.

---

## 11. Что не усложнять в Phase 5

- Не делать TTS/голосовые ответы и realtime STT.
- Не хранить аудио и не строить audio blob store / retry-очередь транскрипции.
- Не добавлять audio endpoints в HTTP API.
- Не вводить env-конфигурацию STT-модели — константа `whisper-1`; отдельные provider/key/endpoint нужны только для credential boundary.
- Не показывать транскрипт пользователю «на подтверждение» — отдельная задача при реальной боли.
- Не расширять conversation-схему БД ради модальности.
- Не добавлять voice-специфичные процессы в Agent Vault: транскрипт — обычный текст для decision plane.
