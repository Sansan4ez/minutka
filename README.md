# Минутка

«Минутка» — Telegram-first сервис исследования рабочих процессов и проектирования автоматизации. Сотрудник ежедневно фиксирует фактическую работу, трудности и рутину; исследовательская команда анализирует псевдонимизированный корпус и execution traces, а компания получает подготовленную карту автоматизации без доступа к исходным разговорам.

Рабочий **прототип** с осознанной ставкой на лёгкую, простую и потому надёжную архитектуру. Построен на [Mastra](https://mastra.ai) + TypeScript.

## Происхождение репозитория

Это **клон репозитория персонального ассистента** (`git@github.com:Sansan4ez/personal-assistant.git`, доступен как remote `assistant`), сделанный по [RFC линейки из трёх продуктов](docs/architecture/rfc-three-products-implementation.md) §2.2. Продукты дальше расходятся: у «Минутки» собственные БД, сервер, Telegram-бот, секреты и трекер. Критичные фиксы общего фундамента (безопасность, потеря данных) переносятся между репозиториями cherry-pick'ом — общая история для этого сохранена.

Клон получает готовыми транспорты Telegram/HTTP/CLI, invite/consent/onboarding/profile-контур, chat-runtime с agent-led routing, процессы утра и вечера и executable specs без сети. Основная новая работа — мультитенантная ось, псевдонимизированный исследовательский корпус, full traces, evidence/evaluation и клиентская карта автоматизации.

## Архитектура в двух словах

Поток: `Telegram / HTTP / CLI → AssistantService → typed use-cases → stores`.

Агент сам роутит по процессам в один ход (agent-led routing), но **не пишет в хранилища напрямую и не выполняет внешних действий без подтверждения** — всё идёт через типизированные use-cases. База знаний хранится файлами (Markdown) в S3/MinIO, без эмбеддингов и векторной БД: файловая навигация проще, прозрачнее в трейсах и дешевле.

Подробнее — в [`AGENTS.md`](AGENTS.md). Целевая архитектура «Минутки» — [RFC исследовательского корпуса и клиентской карты автоматизации](docs/architecture/rfc-minutka-research-corpus-and-reporting.md); переиспользуемый паттерн — [research-corpus-reporting-pattern.md](docs/architecture/research-corpus-reporting-pattern.md); унаследованный рантайм — [RFC архитектуры ассистента](docs/architecture/rfc-personal-assistant-architecture.md) и [agent-led routing](docs/architecture/rfc-agent-led-routing.md).

## Research corpus и граница клиента

- **Канонические данные не обедняются при записи.** Conversation, structured activities и full execution traces сохраняются для ручного анализа, улучшения prompts/taxonomy и evaluation.
- **`subject_key` связывает evidence без имени.** Случайный group-scoped псевдоним позволяет считать contributors, пересчитывать выводы и находить данные для purge/sanitize; в клиентский отчёт он не попадает.
- **Компания получает отдельный артефакт.** У неё нет доступа к corpus, traces, research API/DB и identity mapping; методолог передаёт проверенную карту автоматизации с evidence summary и confidence.
- **Tenant isolation структурна.** Research export и report всегда ограничены company/group scope; данные двух компаний не смешиваются.
- **Secrets исключаются везде.** Credentials не попадают в corpus, traces, model context, operational logs и Git.
- **Данные обратимы.** Пилот допускает ручной retention, но records индексируются для purge, sanitize, correction и recompute.

## Команды

```bash
npm run typecheck      # tsc --noEmit
npm run specs          # executable specs (без сети)
npm run verify         # typecheck + specs
npm run db:migrate     # применить миграции
npm run telegram:dev   # локальный Telegram-бот (polling)
```

## Структура

- [`src/`](src) — код по слоям: `domain/`, `contracts/`, `application/`, `mastra/`, `infrastructure/`, транспорты (`server/`, `telegram/`, `client/`).
- [`vault/`](vault) — Agent Vault: роль агента, навыки-процессы, типизированные действия.
- [`docs/`](docs) — архитектура, конвенции, планы, продуктовый бриф, runbooks.
- [`specs/`](specs) — executable specs, гоняются без LLM/сети через in-memory адаптеры.
- [`migrations/`](migrations) — SQL-миграции PostgreSQL.
- [`nixos/`](nixos) — деплой-стек, унаследованный от ассистента как **шаблон**: секреты и хост не переиспользуются, стек перенастраивается под собственный сервер «Минутки» до первого деплоя.

## Статус

Прототип перед первым пилотом в компании. Планка качества и модель угроз — [`docs/architecture/rfc-pilot-quality-bar.md`](docs/architecture/rfc-pilot-quality-bar.md) (унаследован от ассистента, контур пилота у «Минутки» другой — см. `AGENTS.md`). Отслеживание задач — через [beads](https://github.com/Dicklesworthstone/beads_rust) (`br`) в [`.beads/`](.beads), префикс задач `mnt`; планы ведутся эпиками, см. [`docs/plans/README.md`](docs/plans/README.md).
