# Анализ репозитория Eggent и соотношение с personal-assistant

Дата: 2026-07-23. Исследованы `/home/admin/eggent` (v0.2.0, MIT, [eggent-ai/eggent](https://github.com/eggent-ai/eggent)) и текущее состояние personal-assistant (ветка `main`). Интерактивная версия отчёта: [eggent-analysis.html](eggent-analysis.html).

---

## 1. Как проекты соотносятся

**Eggent** — браузерный «local-first AI workspace»: Next.js 15 + React 19, агентское ядро — сторонний рантайм `@earendil-works/pi-coding-agent` (^0.81). Каждый *проект* — каталог-агент со своими `context.md`, `memory.md`, скиллами (Agent Skills spec, `SKILL.md`), MCP-конфигом (`.mcp.json`) и моделью (`model.json`). Поверх: веб-дашборд, чат, Telegram-бот, пайплайны из нескольких агентов, планировщик, External API, локальная транскрипция голоса (whisper.cpp). Все данные — файлы и JSON под `data/`, без СУБД.

**personal-assistant** — Telegram-first прототип с противоположной философией: Mastra-агент без ambient-инструментов, typed use-cases как единственная граница записи, confirm-модель для внешних действий, `AuditEventStore`, бюджетированные проекции `/proc/*`, PostgreSQL (24 миграции) + MinIO (CAS-артефакты), executable specs без LLM/сети.

Соотношение: **соседи по нише, а не конкуренты**. Оба — single-owner ассистенты с Telegram, но Eggent — универсальный workspace с широкими правами агента (bash, файлы, выполнение кода, без аудита — безопасность через доверие владельцу контура), а наш проект — узкий персональный ассистент с формальными гарантиями. Eggent выигрывает в широте продукта, personal-assistant — в строгости фундамента.

### Сравнительная таблица

| Аспект | Eggent | personal-assistant |
|---|---|---|
| Рантайм агента | pi-coding-agent: jsonl-сессии, скиллы, MCP-адаптер, субагенты, расписания (`src/lib/pi/session.ts`) | Mastra: маленький агент, request-scoped toolsets, maxSteps 4 (`src/mastra/agents/personal-assistant-agent.ts`) |
| Философия безопасности | Доверенная песочница: bash, файлы, код; аудита и подтверждений нет | Typed boundary: агент не пишет в сторы, confirm-модель, аудит |
| Мульти-агентность | Пайплайны проектов-агентов + субагенты (`src/lib/pipelines/runner.ts`) | Один агент, agent-led routing в один ход |
| Тестируемость | Только typecheck | Executable specs без LLM/сети, transport parity (`specs/executable/`) |
| Хранилище | Файлы/JSON в `data/`, без СУБД, один инстанс | PostgreSQL (24 миграции, ownership-инварианты) + MinIO CAS |
| Память агента | `memory.md` (token-overlap поиск) + `vectors.json` (эмбеддинги) | Проекции `/proc/*` с бюджетами (48k символов, деградация); vector search отложен |
| Интерфейсы | Web-дашборд + Telegram + External API | Telegram + HTTP SDK + CLI; web-UI нет |
| Telegram | Polling и webhook (автовыбор), HTML-форматирование, staged-прогресс (12/35/75 с), голос, медиа, access-коды, `/new` | Telegraf polling, plain-text, typing каждые 4 с, голос, медиа→CAS, inline-клавиатуры (онбординг, consent, оценки) |
| Голос (STT) | Локально: ffmpeg → whisper.cpp (`src/lib/speech/transcriber.ts`) | Облако: `@mastra/voice-openai` |
| Планировщик | pi-subagents; **не переживает рестарт** (`src/lib/pi/schedule-host.ts`) | Нет; запланирован эпиком D.0 (`prs-yjl`) |
| Внешний API | `POST /api/external/message`: Bearer + timingSafeEqual, sessionId-контекст, 409 на неоднозначные имена, publicMode | Версионированный HTTP API + SDK, rate-limit |
| MCP и скиллы | Per-project `.mcp.json`; SKILL.md, установка с GitHub | MCP нет; процессы vault + typed-действия `bin/` (в реестре пока один: `inbox_capture`) |
| Приватность | Данные в открытых файлах; секреты маскируются | Consent-версионирование (privacy v2), изоляция `userId`, аудит без содержимого |

### Покрытие возможностей (0 — нет … 3 — развито)

| Область | Eggent | PA |
|---|---:|---:|
| Web-интерфейс | 3 | 0 |
| Telegram-бот | 3 | 3 |
| Голос (STT) | 3 (локально) | 2 (облако) |
| Планировщик | 2 | 0 |
| Пайплайны / мульти-агент | 3 | 0 |
| External API | 3 | 2 |
| MCP + каталог скиллов | 3 | 1 |
| Typed-границы и аудит | 0 | 3 |
| Тесты / спеки | 1 | 3 |
| Приватность и consent | 1 | 3 |
| Персистентность (СУБД) | 1 | 3 |

## 2. Можно ли использовать вместе

Да — **как дополнение, по ролям**, с жёсткой границей по данным.

| Сценарий | Вердикт | Суть |
|---|---|---|
| А. Лаборатория процессов | **рекомендовано** | Прототипировать навыки/пайплайны в Eggent на тестовых данных (скилл = текстовый файл, MCP из UI, пайплайн за минуты), затем формализовать проверенную логику в vault-процессы + typed use-cases + спеки PA |
| Б. Внешний исполнитель | **возможно, с оговорками** | PA делегирует обезличенные тяжёлые задачи (research, генерация по публичным данным) через `POST /api/external/message` (stable `sessionId`, выбор проекта по имени), результат возвращается артефактом через типизированный intake PA с записью в аудит. Только неперсональные данные; вызов — typed use-case с подтверждением владельца |
| В. Временный web-UI | **осторожно** | Только как рабочее место экспериментальных проектов; хранилища не пересекаются, прямой доступ к данным PA обошёл бы typed boundary |
| Г. Слияние в один продукт | **не стоит** | Несовместимы рантаймы (pi-coding-agent ↔ Mastra), хранилища (файлы ↔ Postgres/MinIO) и модели безопасности (свободный агент ↔ confirm-граница) |

**Граница:** персональные данные владельца (контакты, финансы, переписка) в контур Eggent не попадают — его агент имеет bash и полный доступ к файлам без аудита. Обмен только обезличенными задачами и артефактами, направление PA → Eggent.

## 3. Что полезного взять

Рантаймы несовместимы, поэтому переносятся **паттерны**, а не код — кроме транскрайбера (почти автономный модуль). MIT позволяет заимствовать код с указанием авторства. Оценки: ценность/трудоёмкость по 5-балльной шкале.

| # | Идея | Ценность | Трудоёмк. | Источник в Eggent | Куда у нас |
|---|---|---:|---:|---|---|
| 1 | **Локальный STT: whisper.cpp + ffmpeg** — ffmpeg → mono 16kHz WAV → `whisper-cli -otxt -nt -l auto`, автозагрузка ggml-base, таймауты | 5 | 2 | `src/lib/speech/transcriber.ts` | Порт `SpeechToTextPort` вместо облачного `@mastra/voice-openai`; голос владельца не покидает контур |
| 2 | **HTML-форматирование в Telegram** — markdown → `parse_mode: HTML` с экранированием (код-фенсы → `<pre>`, жирный, ссылки) | 4 | 1 | `markdownToTelegramHtml` | `src/telegram/telegram-shell.ts` (сейчас plain-text) |
| 3 | **Staged-прогресс** — содержательные сообщения на 12/35/75-й секунде поверх typing | 3 | 1 | `startTelegramProgressNotifier` | Долгие прогоны (встречи, дайджесты) |
| 4 | **Команда `/new`** — ротация session id, явный сброс контекста диалога | 3 | 1 | `createFreshTelegramSessionId` | Telegram-шелл |
| 5 | **Паттерн pipelines** — шаги = отдельные агент-сессии, handoff через общую artifacts-директорию + резюме шагов в промпте (не RAG) | 4 | 3 | `src/lib/pipelines/runner.ts`, `prompt-builder.ts` | E.0/E.1: «транскрипт → протокол → follow-up» над CAS-артефактами |
| 6 | **Референс планировщика** — расписания как данные (`+30s`/cron), host удерживает сессию, вывод в чат. Анти-урок: не переживает рестарт | 3 | 2 | `src/lib/pi/schedule-host.ts` | D.0 (`prs-yjl`) — но хранить в Postgres, восстанавливать при старте |
| 7 | **Loaders документов** — pdf-parse (PDF), mammoth (DOCX), tesseract.js (OCR) | 4 | 2 | `src/lib/memory/loaders/` | E.0 (`prs-pdo`): обработка артефактов inbox |
| 8 | **Детали External API** — sessionId-контракт (`telegram:<botId>:<chatId>`), 409 на неоднозначные имена, `timingSafeEqual`, publicMode-guardrails, маскирование токенов | 3 | 2–3 | `handle-external-message.ts` | Наш HTTP API |
| 9 | **Token-overlap поиск по memory.md** — дешёвый шаг до pgvector | 2 | 1 | `searchProjectMemory` | Точечный подбор контекста в проекциях |
| 10 | **Access-коды с TTL** — sha256-хеш, TTL 30 мин | 2 | 1 | `consumeTelegramAccessCode` | Сверить с invite-seeds |
| 11 | **Docker-hardening** — multi-stage падает при утечке `src/`/`.git`/`.env` в образ, non-root, entrypoint генерирует секрет | 2 | 2 | `Dockerfile`, `scripts/docker-entrypoint.sh` | Будущая контейнеризация PA |
| 12 | **Совместимость с форматом SKILL.md** (Agent Skills spec) | 3 | 2 | `data/projects/<id>/skills/` | Перенос навыков между vault-процессами и внешними каталогами |

### Чек-лист внедрения (рекомендуемый порядок)

- [ ] Подключить локальный whisper.cpp за `SpeechToTextPort` (проверить `SPEC-VOICE-001`)
- [ ] Внедрить HTML-форматирование ответов в Telegram
- [ ] Добавить staged-прогресс и команду `/new`
- [ ] Взять loaders (pdf/docx/OCR) в эпик E.0 (`prs-pdo`)
- [ ] Спроектировать D.0-планировщик с оглядкой на pi-subagents (расписания в Postgres, restart-recovery обязателен)
- [ ] Описать процесс встреч (E.1) как пайплайн с артефакт-handoff
- [ ] Сверить наш HTTP API с деталями External API Eggent
- [ ] Поднять Eggent локально как лабораторию процессов (Docker, 127.0.0.1, только тестовые данные)

## 4. Важная дополнительная информация

**Состояние проекта:**

- Активен: релиз 0.2.0 — 2026-07-22, свежие коммиты, публичный репозиторий, MIT.
- Несостыковка версий: README заявляет «Current version 2.0», фактическая (package.json, CHANGELOG, health) — 0.2.0.
- Двойной рантайм: живой чат идёт через pi SDK, но остался большой legacy-слой собственного агентского цикла (`src/lib/agent/agent.ts` ~42 КБ, `src/lib/tools/tool.ts` ~61 КБ) — при чтении кода легко изучать «мёртвый» путь.

**Риски Eggent (если бы мы на него опирались):**

- *Критично:* агент с bash/файлами/кодом без аудита и подтверждений — несовместимо с нашей моделью персональных данных.
- Планировщик живёт в памяти процесса, задания не восстанавливаются после рестарта (признано в README).
- Файловые JSON-сторы без транзакций и конкурентного доступа, единственный инстанс.
- Пароль по умолчанию admin/admin (со сменой при онбординге); `data/` не шифруется.

**Что Eggent делает хорошо (подтверждает наши решения):**

- Локальный STT без внешних API — приватность как фича.
- `timingSafeEqual`, маскирование токенов, дедупликация Telegram-обновлений, docker-hardening.
- Простая файловая память вместо преждевременного RAG — подтверждает отложенный vector search.
- «Тонкий мост» над готовым агентским рантаймом вместо своего цикла — та же ставка, что у нас на Mastra.

### Полезные команды

```bash
# Попробовать Eggent локально
git clone https://github.com/eggent-ai/eggent.git && cd eggent
npm install && npm run dev            # http://localhost:3000

# Или Docker одной командой (bind по умолчанию 127.0.0.1:3000)
curl -fsSL https://get.eggent.ai | bash

# Вызов Eggent как внешнего исполнителя (сценарий Б)
curl -X POST http://127.0.0.1:3000/api/external/message \
  -H "Authorization: Bearer $EGGENT_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"pa:research-queue","projectName":"Research Agent","message":"Собери обзор по теме X и сохрани результат файлом-артефактом"}'

# Наши проверки после заимствований
npm run verify              # typecheck + executable specs (без сети)
npm run telegram:dev        # локальный бот — проверить STT/форматирование
```

### Привязка к плану (beads)

| Заимствование | Эпик/задача | Комментарий |
|---|---|---|
| Локальный whisper.cpp STT | новая задача | Замена за портом `SpeechToTextPort` |
| Loaders (pdf/docx/OCR) | `prs-pdo` (E.0) | Типизированная обработка артефактов |
| Паттерн pipelines | `prs-pdo` / `prs-t7c` (E.1) | Артефакт-handoff между шагами |
| Референс планировщика | `prs-yjl` (D.0) | Расписания в Postgres, restart-recovery |
| Telegram UX (HTML, прогресс, `/new`) | новая задача | Малые правки `telegram-shell.ts` |

---

*Методика: полное чтение README/CHANGELOG Eggent + два параллельных глубоких обхода кода (214 файлов `src/` Eggent; все слои, vault, specs и миграции personal-assistant). Оценки ценности/трудоёмкости и покрытия — экспертные.*
