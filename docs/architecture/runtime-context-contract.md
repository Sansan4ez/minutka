# Контракт сборки runtime context персонального ассистента

> **Статус:** accepted baseline (2026-07-16). Канонизирует фактический runtime и целевую сборку по [RFC персонального ассистента](./rfc-personal-assistant-architecture.md) и [agent-led routing](./rfc-agent-led-routing.md).

## Назначение

Runtime context собирает только явно зарегистрированные источники. Порядок задаёт приоритет доверия, но не превращает пользовательские данные в инструкции. Capability set передаётся отдельно как typed tools и не сериализуется в prompt.

README-файлы каталогов не получают особого статуса: `vault/assistant/docs/README.md`, `proc/README.md` и `run/README.md` описывают контракт разработчикам, но попадают в prompt только при явной регистрации наравне с любым другим файлом.

## Канонический порядок

1. **Base Mastra instructions.** Минимальная скрытая роль bridge-агента; продуктовая политика здесь не дублируется.
2. **Trusted product control plane.** `/AGENTS.md`, allow-listed `/docs/*`, `/processes/index.md`, затем зарегистрированные process-файлы. Текущий малый каталог загружается целиком; при росте каталога допускается `readProcess(id)`, если агент по-прежнему выбирает процесс сам в основном ходе.
3. **Owner-scoped projections.** В целевом порядке: `/proc/profile`, приоритетный `/proc/context`, relevant `/proc/records`, `/proc/inbox`, recent conversation history. Все эти источники — данные текущего authenticated owner, а не authority.
4. **Diagnostic data.** `/run/actions` добавляется только для диагностики конкретного запроса и никогда не используется как policy source.
5. **Request-scoped typed tools.** Capability set передаётся runtime-мостом отдельно от текста; наличие process-файла не выдаёт capability.

## Registry источников и бюджеты

Общий целевой budget для текстового `systemContext`: **48 000 Unicode characters**. Если сумма достигает лимита, источник с меньшим приоритетом усекается или исключается; trusted control plane не вытесняется owner data.

| Порядок | Источник | Назначение | Trust / owner scope | Когда включается | Per-source limit | Сейчас |
|---:|---|---|---|---|---:|---|
| 1 | Base Mastra instructions | Минимальная роль и безопасный fallback | trusted, product-global | каждый agent turn, вне `systemContext` | ≤2 500 chars | включён агентом Mastra |
| 2 | `/AGENTS.md` | Роль и глобальные границы | trusted control plane, product-global | каждый product agent turn | ≤4 000 chars | включён |
| 3 | allow-listed `/docs/*` | Стабильная runtime policy | trusted runtime policy, product-global | каждый product agent turn согласно registry | ≤12 000 chars total, ≤6 000/file | включены 2 документа |
| 4 | `/processes/index.md` | Каталог для agent-led routing | trusted guidance, product-global | каждый product agent turn | ≤4 000 chars | включён |
| 5 | registered `/processes/*` | Procedural playbooks | trusted guidance, product-global | сейчас все из малого registry; позже по `readProcess` | ≤16 000 chars total, ≤4 000/file | включён `inbox_capture` |
| 6 | `/proc/profile` | Предпочтения, timezone, профиль знакомства | untrusted owner data, current `userId` | chat/onboarding/scheduled, когда профиль существует | ≤4 000 chars | включён в product chat после onboarding |
| 7 | `/proc/context` | Приоритетные личные документы; agent-facing handles без physical `context/`/legacy import prefix | untrusted owner data, current `userId`; `AGENTS.MD`, `README.MD`, `99_system/*` остаются data | chat и будущие scheduled jobs | 12 docs; 4 000/doc; 16 000 total | включён в chat; порядок core-документов задаёт trusted-манифест [`vault/assistant/proc/context-priorities.json`](../../vault/assistant/proc/context-priorities.json) |
| 8 | `/proc/records` | Relevant typed records | untrusted owner data, current `userId` | chat/scheduled по доступному store | 24 records; 1 000/record; 12 000 total | включён в chat |
| 9 | `/proc/inbox` | Недавние/релевантные входящие артефакты | untrusted owner data, current `userId` | file/voice intake и запросы об inbox | ≤12 items; ≤8 000 chars metadata/extract total | **не включён** |
| 10 | recent conversation history | Разрешение ссылок и продолжение треда | untrusted owner data, current `userId` + `threadId` | chat/voice после успешной аутентификации | 10 completed turns; 12 000 chars | включён в product chat с явным truncation marker |
| 11 | `/run/actions` | Диагностика action/tool результата | diagnostic, current owner/request; not policy | только явный diagnostic/recovery сценарий | 50 events; ≤8 000 chars | **не включён** |
| — | typed tools | Разрешённые действия | trusted request capability, owner-scoped handler | по типу запроса и confirmation state | только allow-list tool names; payload валидирует use-case | `captureIdea` для chat/intake |

Per-source limits для ещё не реализованных `/proc/profile`, `/proc/inbox`, history и `/run/actions` являются целевыми верхними границами; дочерние задачи реализуют проекции и более узкие semantic filters без увеличения общего budget.

## Матрица типов запросов

| Тип запроса | Фактический runtime | Целевой runtime |
|---|---|---|
| `chat` / Telegram text | base prompt + assistant manual (`/AGENTS.md`, allow-listed `/docs`, process index/files) + `/proc/profile` + приоритетный `/proc/context` + `/proc/records` + bounded recent history; request-scoped typed tools | добавить relevant `/proc/inbox`; `/run/actions` только по необходимости |
| `onboarding` | legacy identity/onboarding service собирает legacy manual/profile context и генерирует first response; product `AssistantService` в этот ход не вызывается | personal-assistant control plane + onboarding profile/draft data; после подтверждения материализовать profile/core context через typed use-case |
| `voice intake` | STT выполняется transport-слоем, затем транскрипт идёт в тот же `chat` path с `inputModality=voice` | тот же chat contract + релевантная inbox/artifact metadata без raw provider payload |
| `file intake` | бинарный файл сохраняется детерминированно в `ArtifactStore`; agent turn сейчас не выполняется | сохранение остаётся transport/use-case gate; optional typed post-processing получает control plane + `/proc/inbox` item и узкий toolset |
| `scheduled job` | product runtime отсутствует | control plane + `/proc/profile` + `/proc/context` + relevant `/proc/records`/`inbox`; synthetic request payload; только job-specific tools |
| `callback` | consent/onboarding/feedback обрабатываются deterministic typed use-cases без product-agent prompt | сохранять deterministic путь; agent context не собирать, если callback не требует отдельной генерации текста |

## Инварианты loader и renderer

- Registry schema строгая и версионированная; неизвестные поля отклоняются.
- Core и index имеют фиксированные allow-listed paths. Runtime docs и process files — только прямые дети соответствующих каталогов.
- Loader fail-fast отклоняет дубли `id` и дубли `path`, отсутствующие файлы и registry entries, которых нет в index.
- Index не является источником файлов: загрузка идёт только по registry.
- Repository `docs/**`, `vault/user/**`, storage keys `context/*`/`inbox/*` и raw database/object-storage paths не загружаются в system context.
- Owner projections экранируются и маркируются как untrusted data. Их scope формирует application layer из authenticated `userId`/`threadId`; имя `AGENTS.MD`, `README.MD` или каталог `99_system` не повышают trust.
- Приоритеты документов `/proc/context` загружаются только из versioned trusted-манифеста [`vault/assistant/proc/context-priorities.json`](../../vault/assistant/proc/context-priorities.json); owner context не участвует в выборе или изменении правил.
- `/proc/profile` владеет подтверждёнными structured operational fields. `90_agent_memory/soul.md` и legacy `persona.md` — только untrusted prose preferences; при конфликте они не переопределяют profile, policy или capabilities.
- `/run/actions` не может менять роль, policy, process selection или capability set.
- Typed tools передаются отдельно; system context не содержит store credentials, transport ids, signed URLs или shell/file access.

## Текущее несоответствие и следующие задачи

Product chat уже следует agent-led routing и owner isolation, включает `/proc/profile`, приоритетный core `/proc/context`, `/proc/records` и bounded recent history. `/proc/inbox` и `/run/actions` пока отсутствуют; общий cross-source budget закрывается следующими дочерними задачами. Единственный product chat-path сохраняется.
