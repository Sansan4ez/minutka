# Buzz от Block: глубокое техническое исследование Nostr-платформы для совместной работы людей и агентов

## TL;DR
- **Buzz** — это self-hostable рабочее пространство (аналог Slack+GitHub) от Block, Inc. (компания Джека Дорси), где люди и AI-агенты являются равноправными участниками; технически это **Nostr-релей на Rust** (Apache-2.0), в котором каждое действие — подписанное событие Nostr в одном логе. Проект запущен публично 21 июля 2026 г. (десктоп v0.4.21 в день запуска) и является **ранним/alpha-продуктом**, а не зрелой production-платформой.
- **Nostr выбран ради идентичности**: каждый участник (человек или агент) владеет собственной парой ключей secp256k1, портируемой между любыми Nostr-совместимыми системами; это даёт независимость от вендора, self-hosting релея, единый аудит-лог и расширяемость через `kind`-номера. Расплата — «децентрализация» в Buzz сегодня номинальная: один релей = один workspace, нет P2P-репликации, нет federation, а сквозного E2E-шифрования (NIP-44) для DM пока нет.
- **Агенты — граждане первого класса**: подключаются через harness `buzz-acp` (мост ACP↔MCP) с поддержкой Goose, Codex, Claude Code или собственного `buzz-agent`; управляют платформой через агент-first CLI `buzz-cli` (JSON in/JSON out) и MCP-инструменты. Бизнес-автоматизация реализована YAML-workflow'ами, но ряд функций (approval-гейты, часть actions) ещё не доведены до конца.

## Key Findings

**Что это и статус.** Buzz — «hive mind communication platform», выпущенная Block 21 июля 2026 г. под Apache-2.0. Репозиторий `github.com/block/buzz` — Rust-монорепо. Проект открыто позиционируется как незавершённый: README прямо делит функции на «✅ Works today / 🚧 Being wired up / 💭 Strong opinions, pending code». Это ранняя, активно меняющаяся кодовая база: версия v0.4.21 отгружена в день запуска 21 июля 2026 (по данным AI Chat Daily, «Version 0.4.21 shipped July 21»), следующая сборка — v0.4.22 (GitHub issue #2343: «Buzz Desktop v0.4.22 (x64 setup alpha unsigned)»); Windows-инсталлятор не подписан, документация местами разрежена. Есть управляемый хостинг на buzz.xyz и внутренняя сборка для сотрудников Block (`squareup/buzz-releases`). По популярности: Rohit Raj (rohitraj.tech) сообщает «It hit 7,600+ GitHub stars in three days», а основная страница репозитория в более позднем срезе показывала ~13,2 тыс. звёзд.

**Происхождение.** Buzz вырос из внутреннего инструмента Block BuilderBot: по данным The New Stack и block.xyz, BuilderBot «executes over 200,000 operations per day and merges approximately 1,500 pull requests per week, about 15% of all production code changes across Block». Это объясняет «агент-first» дизайн платформы.

**Стек и архитектура.** Backend — Rust (Cargo-workspace из ~20+ крейтов), клиенты — TypeScript/React (десктоп на Tauri 2 + React 19), мобильный клиент — Flutter (в разработке). Инфраструктура: **PostgreSQL 17** (хранилище событий + полнотекстовый поиск), **Redis** (pub/sub, presence, typing), **S3/MinIO** (медиа через протокол Blossom). Ключевой принцип: **релей — единственный источник истины**, нет P2P/gossip/репликации.

**Nostr.** Buzz использует NIP-01 (формат событий) на проводе и является **NIP-29-релеем** (relay-based groups) нативно. Реализованы NIP-42 (аутентификация), NIP-98 (HTTP-auth для агентов), NIP-25 (реакции), NIP-09 (удаления), NIP-10 (треды), NIP-17 (gift-wrapped DM), NIP-50 (поиск), NIP-34 (git-события), NIP-11/NIP-05 (метаданные/идентичность), Blossom BUD-01/02 (медиа). Есть NIP-28-совместимый прокси (`buzz-proxy`) для сторонних клиентов.

**Документы.** «Документы» в Buzz — это канальные **canvas'ы** (kind 40100, один общий документ на канал) и медиа-файлы (Blossom/S3). Всё хранится как события Nostr в Postgres. Версионирование — через события правки/soft-delete + аудит-лог. Права доступа — только через членство в канале. Шифрование — TLS в транзите + at-rest на уровне хранилища (Postgres TDE / шифрование томов); E2E пока нет.

**Поиск.** Полнотекстовый поиск на **PostgreSQL FTS** (генерируемая колонка `search_tsv` типа tsvector + GIN-индекс), доступен через NIP-50 и REST `/api/search`. Векторного/семантического поиска (эмбеддинги, sqlite-vec, lancedb, tantivy) в проекте нет. Ранняя версия архитектуры использовала Typesense, но актуальная кодовая база перешла на Postgres FTS.

**Агенты.** Контекст для агента формируется из событий канала: при @mention harness `buzz-acp` собирает события, батчит их в один prompt и отправляет агенту через ACP (JSON-RPC 2.0 по stdio). Агент выполняет работу инструментами MCP (`buzz-dev-mcp` даёт shell, str_replace, todo) и **публикует ответ, сам вызывая `buzz messages send` через CLI**. Провайдер LLM у `buzz-agent` переключается переменной окружения `BUZZ_AGENT_PROVIDER`.

## Details

### 1. Общее описание проекта

**Что такое Buzz.** Согласно README, Buzz — «a workspace where humans and agents build together, on a relay you own» и «self-hostable workspace where humans and AI agents share the same rooms». Практически это выглядит как командный мессенджер (каналы, треды, DM, форум, голосовые huddle, canvas'ы, медиа, поиск), но «под капотом» — event-log Nostr. Ключевой тезис репозитория: «every message, reaction, workflow step, review approval, and git event is a signed event in one log. Same shape, same identity model, same audit trail, whether the author is a person or a process».

**Кто и зачем создал.** Block, Inc. (ранее Square; компания Джека Дорси). Мотивация — из официального заявления Block 21 июля 2026 (цитируется в Decrypt), Bradley Axen, Head of AI Capabilities: «Every company is going to need a place where humans and agents work together. The question is whether that place is proprietary or open. We built Buzz because we believe it should be open». Дорси анонсировал проект в X 21 июля 2026: «a new groupchat platform for teams of people and agents of all sizes, built to reduce our dependency on slack and github. model-agnostic, decentralized, self-sovereign, and open source». Проект развивает линию Дорси на открытые протоколы; Block финансирует Nostr с 2022 г.: по данным CoinDesk (15 дек. 2022), «Jack Dorsey donated roughly 14 BTC, worth about $245,000, to further fund development of Nostr... he deployed funds to developer fiatjaf» (твит Дорси: «14 BTC deployed to @fiatjaf for #nostr»).

**Статус.** Ранний/alpha. Это подтверждают и README (💭-колонка с нереализованными функциями), и независимый разбор Darren Robinson (blog.darrenjrobinson.com): «Buzz is built by Block (Jack Dorsey's company). It's in alpha, the Windows installer is unsigned, and the documentation is sparse in places», и VISION.md (мобильный клиент 🚧, approval-гейты 🚧, push-уведомления и culture-функции 📋). Важно: **Buzz — не блокчейн и без токенов** («Not blockchain. Signed events are useful without making everyone buy a commemorative coin»).

**Лицензия.** Apache-2.0.

**Стек.** Rust backend; TypeScript/React + Tauri 2 (desktop); Flutter (mobile, в разработке); Postgres 17, Redis 7, S3/MinIO, ранее Typesense (в актуальной версии — Postgres FTS). Требования для сборки: Docker + Hermit (или Rust 1.88+, Node 24+, pnpm 10+, `just`).

**Архитектура (клиент/сервер/релеи).** Единственный сервер — `buzz-relay` (Axum, WebSocket + узкий REST). Клиенты (десктоп, CLI, агенты) соединяются по WebSocket (+ REST). Крейты:
- **Core protocol**: `buzz-core` (zero-I/O типы, NIP-01-фильтры, проверка Schnorr, реестр kind'ов — 81 kind), `buzz-relay` (сервер).
- **Services**: `buzz-db` (Postgres), `buzz-auth` (NIP-42/98, scopes, rate-limiting), `buzz-pubsub` (Redis), `buzz-search` (Postgres FTS), `buzz-audit` (hash-chain лог), `buzz-workflow` (YAML-движок).
- **Agent surface**: `buzz-cli`, `buzz-acp` (ACP-harness), `buzz-agent` (минимальный ACP-агент), `buzz-dev-mcp` (shell + file-edit), `buzz-persona` (персоны), `sprig` (all-in-one harness).
- **Git & pairing**: `git-sign-nostr`, `git-credential-nostr`, `buzz-pair-relay`, `buzz-pairing-cli`.
- **Shared/Tooling**: `buzz-sdk`, `buzz-media`, `buzz-admin`, `buzz-ws-client`, `buzz-test-client`.

**Запуск/деплой.** Для разработки: `git clone`, `. ./bin/activate-hermit`, `just setup && just build`, `just dev` (релей + десктоп; релей на `ws://localhost:3000`). Для агентов: задать `BUZZ_PRIVATE_KEY` и использовать `buzz-cli`. Для одноузлового/VPS-деплоя — production Compose-бандл в `deploy/compose/` (Postgres, Redis, MinIO, опционально Caddy/TLS). Корневой `docker-compose.yml` — только для разработки. **Важная деталь эксплуатации** (из независимого разбора Darren Robinson): `minio-init` должен создать bucket `buzz-media` до старта релея, иначе релей падает; Tauri-клиент под Windows использует mDNS-hostname в `Host`-заголовке, что может ломать резолвинг community.

Модель мультитенантности: «community» = workspace, определяемый URL/доменом. В single-relay-режиме (то, что поставляется сегодня) один релей = одно community. В хостинговом multi-tenant-режиме несколько community делят Postgres/Redis/S3, но tenant-observable-состояние скоупится по host-derived community.

### 2. Nostr в проекте

**Как используется.** Buzz — это NIP-29-релей (relay-based groups). Каналы Buzz идентифицируются UUID и скоупятся тегом `#h` (групповой тег NIP-29), а не `#e`. Каждое событие — стандартный объект NIP-01 (id/pubkey/kind/tags/content/sig), подпись Schnorr над secp256k1, id = SHA-256 канонической сериализации. `kind` — единственный «переключатель» маршрутизации.

**Kind'ы и типы событий (из ARCHITECTURE.md и NOSTR.md):**
- Стандартные: kind 0 (профиль), 5 (удаление, NIP-09), 7 (реакция, NIP-25), 9 (сообщение группы NIP-29), 1059 (gift-wrap DM, NIP-17), 22242 (AUTH, никогда не хранится).
- NIP-29-админ: 9000 (add user), 9001 (remove), 9002 (edit metadata), 9005 (admin delete), 9007 (create group), 9008 (delete group), 9021 (join request), 9022 (leave); 9009 (invite) — принимается, но обработчик отложен (no-op).
- Relay-signed discovery: 39000 (метаданные группы), 39001 (админы), 39002 (участники); 39003 (роли) — определён, но не эмитится.
- Уведомления о членстве: 44100 (added) / 44101 (removed) — только relay-подпись, глобальный scope.
- Эфемерные: 20001 (presence), 20002 (typing) — не хранятся.
- Buzz-кастомные (40000+): 40002 (Stream message v2), 40003 (edit), 40100 (canvas), 43001 (job request агента), 45001/45003 (форум-пост/коммент), 46001–46012 (workflow-события).
- Git (NIP-34): 1621 (bug report/issue), 30617 (repo announcement), плюс патчи/статусы; треды-комментарии — NIP-22 kind 1111.

**Релеи.** Один релей на community. Список релеев/outbox (NIP-65) не поддерживается («Single-relay architecture»).

**Ключи npub/nsec, подписи.** Идентичность = пара ключей secp256k1 (Nostr-native), NIP-05-хэндл вида `alice@example.com`, NIP-42-Schnorr-auth (люди) или NIP-98-Schnorr-auth (агенты). Аутентификация проактивная: релей сразу шлёт `["AUTH", <challenge>]`, клиент отвечает подписанным событием. Толеранс времени NIP-42 — ±60 сек. Есть опциональный allowlist pubkey (`BUZZ_PUBKEY_ALLOWLIST`, fail-closed).

**Шифрование.** Модель одна: TLS в транзите + at-rest на уровне хранилища. Server-managed-шифрование покрывает все каналы/DM/события (для eDiscovery). **NIP-04/NIP-44 не реализованы**; DM реализованы через NIP-17 gift-wrap (kind 1059) с эфемерными ключами подписи, хранятся глобально, доставляются по `#p`-фильтрованным подпискам, в поиске не индексируются. E2E-шифрование (NIP-44) для DM — «future consideration».

**Групповые чаты / MLS / White Noise.** Buzz использует **NIP-29** (relay-enforced groups) — не MLS/NIP-EE. Это стоит отличать от связанных Nostr-инициатив: **White Noise** (Max Hillebrand) строит E2E-групповые чаты на **MLS (RFC 9420)/NIP-EE** с сокрытием метаданных через NIP-59 gift-wrap; **Damus** — флагманский Nostr-клиент, спонсируемый в т.ч. Дорси. Buzz сознательно выбрал relay-enforced-модель (NIP-29) ради серверного контроля доступа, аудита и eDiscovery, пожертвовав приватностью метаданных и E2E, которые дают MLS-подходы.

**Зачем Nostr и преимущества.** Официальная мотивация Block: «We chose Nostr because it solves the most fundamental problem in multi-agent collaboration: identity. Every participant, human or agent, holds a cryptographic keypair that belongs to them, not to the platform... It's portable, verifiable, and independent». Конкретные преимущества против альтернатив:
- **vs Slack/Discord/Teams/Google Workspace (централизованные API)**: нет вендор-лока, идентичность агента не привязана к аккаунту/API-ключу вендора и переносима между любыми Nostr-системами; self-hosting релея (данные и код не покидают вашу инфраструктуру); единый подписанный аудит-лог вместо 4+ разных систем идентичности; расширяемость новым `kind` без слома клиентов.
- **vs ActivityPub/Matrix/XMPP**: у Nostr радикально простая модель (подписанный JSON-объект + релей, без федеративной сложности Matrix/сложных S2S-протоколов XMPP); криптографическая идентичность встроена в протокол.
- **vs IPFS**: Buzz — не контент-адресуемое P2P-хранилище; для медиа используется content-addressed Blossom поверх S3, но истина — в релее.
- **vs обычные REST/WebSocket-бэкенды**: получаете realtime fan-out, скоупинг NIP-29 и единый auth-пайплайн «бесплатно», добавляя новый kind, а не новый эндпоинт (принцип из AGENTS.md: «Prefer Nostr events over new HTTP endpoints»).

**Недостатки и ограничения выбора Nostr.** Честно признаётся в самом проекте и в критике:
- «Децентрализация» сегодня номинальна: релей — единственный источник истины, нет P2P/gossip/репликации, нет federation (в roadmap). ExplainX (explainx.ai, 22 июля 2026): «the 'decentralized' framing describes deployment flexibility, not peer-to-peer replication, which Block's own docs confirm doesn't exist yet».
- Launch-тред на Hacker News собрал 365 баллов и 325 комментариев в день запуска (по данным Enterprise DNA). Обсуждали, является ли Nostr-фундамент «несущим» или «crypto theater поверх проблемы прав доступа»; по Northeast Times, «A Slack employee raised data-leakage concerns» при работе нескольких агентов в общих каналах, а «Someone noted the irony of a GitHub alternative being hosted on GitHub».
- Нет E2E (NIP-44) — приватность метаданных хуже, чем в MLS-подходах (White Noise).
- Rate-limiting не реализован (только тестовая заглушка `AlwaysAllowRateLimiter`) — потенциальная уязвимость к DoS в production.
- Единый релей = единая точка отказа/цензуры внутри community (Nostr censorship-resistance проявляется только при мульти-релейности, которой тут нет).

### 3. Кейсы использования

**Стандартные (задуманные авторами):**
1. **Incident memory / форензика инцидентов.** Агент в инцидент-канале по запросу «have we seen this error before?» ищет полгода истории и постит треды, root-causes, фиксы с «квитанциями». Преимущество против Slack+GitHub+CI: сообщение, NIP-34-патчи, workflow-шаги и апрувалы — один подписанный, поисковый лог, а не 4 разные системы аудита.
2. **Branch as room.** Открытие фичеветки создаёт канал; патчи приходят как NIP-34-события, CI постит результаты, агент делает first-pass review, merge-решение живёт рядом с доказательствами; при merge канал архивируется в постоянную запись «почему этот код существует». Против GitHub: обсуждение и код в одном месте, агенты — полноценные участники.
3. **Release that writes itself.** Workflow срабатывает на теге; агент читает merged PR из канала, формирует draft release notes, постит на ревью, получает 👍 и публикует. Против Slack-workflow/GitHub Actions: каждый шаг подписан и ищется.
4. **Multi-agent code review.** Канал ревью содержит агента-ревьюера (напр. Claude Code со skill'ом ревью), автора и CI-workflow как участников.
5. **Living documents.** Canvas'ы, редактируемые людьми и агентами через MCP; агент-докрайтер следит за ref-обновлениями и предлагает правки.

**Нестандартные/креативные (из практики сообщества и VISION):**
- **Гостевой доступ для внешних (инвесторы, пресса, партнёры)** через `buzz-proxy` (NIP-28) — они подключаются своим Nostr-клиентом (Coracle, Amethyst, nak) без корпоративных креденшелов, со скоупом на конкретные каналы.
- **Кросс-платформенные агенты как первоклассные участники**: в независимом разборе Darren Robinson поднял агентов OpenClaw и нативного Claude Agent SDK как членов Buzz-community в домашней лаборатории через ACP.
- **Buzz Mesh**: пул opted-in GPU членов community как локальный OpenAI-совместимый провайдер для агентов (в VISION помечено как реализуемое; «mesh-llm over iroh»).
- **Голосовые huddle с агентами**: агенты присоединяются к тому же Opus-аудиорелею, что и люди, приносят свой STT/TTS.

**Преимущества против конкретных платформ.** Против **Notion/Google Workspace/ChatGPT Enterprise**: единый event-log и идентичность агента вместо разрозненных документов + черноящичных API-вызовов; каждое действие агента подписано, датировано и ищется. Против **LangChain-агентов и проприетарных агент-платформ**: нет вендор-лока на модель/фреймворк (model-agnostic), идентичность и репутация агента переносимы, containment через идентичность (у агента свои ключи, членства и аудит), а не через permission-флаги.

### 4. Документы

**Что и как хранится.** «Документы» в Buzz представлены двумя сущностями:
- **Canvas** (kind 40100) — один общий редактируемый документ на канал; чтение/запись через десктоп или MCP-инструменты. Хранится как событие Nostr в Postgres.
- **Медиа-файлы** — загрузка через Blossom (BUD-02 `PUT /media/upload`, BUD-01 `GET /media/{sha256}.{ext}`), хранение в S3/MinIO, content-addressed по SHA-256. Лимит блоба — 50 МБ; серверные thumbnail'ы.
- **Форум-посты** (kind 45001/45003) — длинные асинхронные треды.

**Структура хранения.** Все стойкие события — в таблице `events` PostgreSQL, помесячно партиционированной по `created_at` (`PARTITION BY RANGE`). Нет отдельной БД для документов, нет SQLite, нет векторного хранилища. Медиа — в объектном хранилище; метаданные — в Postgres.

**Версионирование.** Через события правки (kind 40003 edit) и soft-delete (удалённые события остаются в аудит-логе). Полноценного git-подобного версионирования у canvas'ов из документации не следует (это стоит указать как непокрытое).

**Права доступа.** Единственный гейт — членство в канале; релей проверяет доступ до регистрации подписки (нет гонки для приватных каналов). Каналы: Open (self-join), Private (invite-only), DM (до 9 участников), Guest (скоуп на конкретные каналы).

**Шифрование.** TLS в транзите + at-rest на уровне хранилища (Postgres TDE, шифрование томов). E2E нет.

**Синхронизация между устройствами.** Через релей (единый источник истины) + NIP-AB device pairing (`buzz-pair-relay`/`buzz-pairing-cli`). Нет P2P/offline-first CRDT-синхронизации (не документировано).

**Ограничения размера.** Max WebSocket-frame — 65 536 байт; max подписок на соединение — 1024; max исторических результатов на фильтр — 500; медиа-блоб — 50 МБ; feed hard cap — 100 строк.

### 5. Поиск

**Движок.** Полнотекстовый поиск на **PostgreSQL FTS**: поиск идёт по генерируемой колонке `search_tsv` (tsvector) на таблице `events`, с GIN-индексом, без отдельного сервиса/коллекции. Крейт — `buzz-search` (query, delete). (Более ранняя версия ARCHITECTURE.md описывала Typesense как отдельный сервис — это устаревшая деталь; актуальная кодовая база использует Postgres FTS.)

**Интерфейсы.** NIP-50 (`{"search":"query","kinds":[9],"#h":["<uuid>"]}` → релевантно-отсортированные результаты → EOSE; не регистрируется как постоянная подписка), REST `/api/search`, HTTP `POST /query` (NIP-50-фильтры автоматически маршрутизируются в `buzz-search`). Индексация — fire-and-forget через bounded worker queue (capacity 1000) в event-pipeline.

**Права.** Фильтрация по правам — ответственность вызывающего (`buzz-search` предоставляет механизм `filter_by`, но сам не энфорсит членство).

**Чего нет.** Векторного/семантического поиска, эмбеддингов, RAG-компонентов, sqlite-vec/lancedb/tantivy — в проекте **нет**. Поиск по нескольким релеям невозможен (single-relay). DM (NIP-17) в поиске не индексируются.

### 6. Агенты

**Модель.** Агент = участник канала с собственной парой ключей, профилем, presence и bot-ролью. Добавляется в канал как человек; на @mention отвечает сообщением от своей Nostr-идентичности, неотличимым в UI от человеческого.

**Как формируется контекст (context engineering).** `buzz-acp` — standalone-бинарник, мост между событиями релея и агентами через **ACP (Agent Client Protocol, JSON-RPC 2.0 по stdio)**:
- Соединяется с релеем по WebSocket (NIP-42), обнаруживает каналы через REST, ставит `@mention`-события в очередь по каналам.
- На канал — не более одного prompt'а «в полёте»; последующие @mention'ы копятся, батчатся в один prompt и отправляются через `session/prompt`.
- Пул из 1–32 субпроцессов-агентов (по умолчанию 1), claim/return-жизненный цикл, авто-респаун при краше.
- Последовательность ACP: `initialize` → `session/new` (возвращает `sessionId`, camelCase критичен) → `session/prompt` (`{"sessionId","prompt":[{"type":"text","text":...}]}`) → `session/end`.
- `buzz-acp` передаёт агенту системный промпт `base_prompt.md` через `params.systemPrompt` в `session/new`. Ключевой нюанс: **`buzz-acp` не автопостит ответ** — модель сама обязана вызвать `buzz messages send` через CLI («If your turn produced anything worth knowing, you MUST publish it... Ending that kind of turn without a message is a silent failure»). Значит агенту нужны: (1) shell/bash-доступ, (2) переданный системный промпт, (3) режим `bypassPermissions` для unattended-работы.

**MCP / tool use.** `buzz-dev-mcp` — MCP-сервер, дающий любому агенту `shell`, `str_replace`, `todo` (+ `rg` и `tree` на PATH). Каждая ACP-сессия получает свой изолированный набор MCP-серверов. Собственный `buzz-agent` — минимальный ACP-агент (до 8 конкурентных сессий; при заполнении контекста сессия суммаризирует свою историю и продолжает).

**Настройка (конфигурация, провайдеры LLM).** Buzz model-agnostic и agent-agnostic. Через `buzz-acp` поддерживаются готовые harness'ы: **Goose** (собственный агент Block, выпущенный в январе 2025; по данным The New Stack, «That project now has more than 50,000 GitHub stars»), **Codex** (OpenAI), **Claude Code** (Anthropic), плюс любой ACP/MCP-совместимый. Auth-переменные (`BUZZ_RELAY_URL`, `BUZZ_PRIVATE_KEY`, `BUZZ_AUTH_TAG`) автоинжектятся harness'ом в субпроцессы агентов. Для `buzz-acp` в `.env.example` документированы `BUZZ_ACP_AGENT_COMMAND` (напр. `goose`), `BUZZ_ACP_MODEL`, `BUZZ_ACP_SYSTEM_PROMPT`, `BUZZ_ACP_MCP_COMMAND`. Для собственного `buzz-agent` провайдер LLM выбирается переменной **`BUZZ_AGENT_PROVIDER`** (значение `openai` требует `OPENAI_COMPAT_API_KEY`; поддерживается и Anthropic через `ANTHROPIC_API_KEY`) — «Swap the LLM provider with one environment variable».

**Персоны и команды.** Персона = «модель + системный промпт + набор MCP-toolset'ов». Команда = именованная группа персон (пример из VISION.md: Ralph для code review, Scout для research, Reviewer для crossfire). Встроенные персоны поставляются с десктоп-клиентом (в alpha-сборке наблюдались дефолтные агенты Fizz/Honey/Bumble с `agent_command: buzz-agent`, `mcp_command: buzz-dev-mcp`); операторы определяют свои. **Точный формат файла-конфигурации персоны (TOML/YAML/JSON/MD) и схема определения команды в открытых источниках не задокументированы — управление персонами/командами происходит через десктоп-клиент («desktop-managed»).**

**Интеграция с goose.** Goose — открытый on-machine агент Block, комбинирующий рассуждения LLM с исполнением инструментов через MCP; поддерживает ACP-провайдеры. В Buzz он подключается как один из harness'ов через `buzz-acp`.

### 7. Практическое руководство: настройка агентов под бизнес-процессы

**Базовая схема подключения агента.**
1. Сгенерировать ключи: `buzz-admin generate-key` (для релея и для каждого агента).
2. Задать агенту окружение: `BUZZ_PRIVATE_KEY`, `BUZZ_RELAY_URL` (напр. `ws://host:3000`), провайдер (`BUZZ_AGENT_PROVIDER`/`ANTHROPIC_API_KEY` или харнесс-специфичные).
3. Запустить harness, указав команду агента, напр. (из реального systemd-примера сообщества):
```
buzz-acp \
  --agent-command node \
  --agent-args /path/to/agent/index.js \
  --subscribe mentions
```
4. Добавить агента в нужный канал через десктоп (как человека).

**Бизнес-автоматизация через workflow'ы (`buzz-workflow`).** YAML-as-code, канально-скоупленные. 4 триггера: `message_posted`, `reaction_added`, `schedule` (cron, тик каждые 60с), `webhook` (HMAC-verified). 7 actions: `send_message`, `send_dm` (⚠️ NotImplemented, WF-07), `set_channel_topic` (⚠️ NotImplemented, WF-07), `add_reaction`, `call_webhook` (SSRF-protected, редиректы off, cap 1 MiB), `request_approval` (⚠️ approval-гейты не доведены end-to-end, WF-08 — run падает), `delay` (≤300с). Условия — через `evalexpr` с функциями `str_contains/str_starts_with/str_ends_with/str_len`. Шаблоны: `{{trigger.text}}`, `{{trigger.author}}`, `{{steps.ID.output.FIELD}}` (single-pass). Конкурентность — семафор на 100 permits (при переполнении — `CapacityExceeded`, без очереди).

Реальный пример из ARCHITECTURE.md (Incident Triage):
```yaml
name: "Incident Triage"
trigger:
  on: message_posted
  filter: "str_contains(trigger_text, 'P1')"
steps:
  - id: notify
    action: send_message
    text: "P1 incident detected: {{trigger.text}}"
  - id: page
    if: "str_contains(trigger_text, 'production')"
    action: request_approval
    from: "{{trigger.author}}"
    message: "Page on-call?"
```

**Сценарии бизнес-процессов (насколько реализуемо сегодня):**
- **Code review**: агент-ревьюер (Claude Code/Goose со skill'ом ревью) в канале-ветке; триггер на NIP-34-патч → first-pass review постится в канал.
- **Ресёрч**: персона Scout по @mention ищет историю каналов (NIP-50) и внешние источники через MCP-инструменты, постит сводку в canvas.
- **Отчётность/релизы**: schedule/webhook-триггер → агент собирает merged-патчи → draft release notes → `request_approval` (когда WF-08 будет доведён) → публикация.
- **Обработка входящих заявок / поддержка клиентов**: webhook-триггер создаёт событие в канале → агент триажит и отвечает; можно вынести внешних клиентов через `buzz-proxy` (NIP-28) с гостевыми токенами.
- **Автоматические уведомления**: `message_posted`+`filter` → `send_message`/`add_reaction`/`call_webhook` в внешние системы.

**Важные оговорки для практики.** Approval-гейты, `send_dm`, `set_channel_topic` пока не работают (падают/no-op). Rate-limiting не энфорсится. Windows-агентам нужен Git Bash (или `BUZZ_SHELL`). Агент без shell-доступа/системного промпта/`bypassPermissions` «молча» не отвечает.

## Recommendations

**Кому и когда пробовать сейчас (июль 2026).**
1. **Пилот на изолированном сценарии, не в проде.** Если у вас уже есть команда на Claude Code/Codex/Goose — клонируйте репозиторий, поднимите `just dev`, посадите одного кодового агента в приватный канал с реальным багом (branch-as-room). Это даст быструю обратную связь о зрелости.
2. **Для self-host заложите инженерное время.** Вы эксплуатируете Postgres + Redis + MinIO + WebSocket-релей + git-backend. Обязательно: `minio-init` до старта релея; корректный `RELAY_URL`/`Host` (особенно для Tauri/Windows-клиентов, mDNS-ловушка); TLS через Caddy для production.
3. **Гостей и внешних участников** подключайте через `buzz-proxy` (NIP-28) со скоуп-токенами, не давая корпоративных креденшелов.

**Пороговые условия, меняющие рекомендацию (когда переходить к более серьёзному внедрению):**
- Появление **rate-limiting** и доведённых **approval-гейтов (WF-08)** и actions (WF-07) — до этого не строить на них комплаенс-процессы (README прямо просит этого не делать).
- Появление **E2E (NIP-44)** для DM — критично для чувствительных коммуникаций.
- Стабилизация **мобильных клиентов** и **push-уведомлений**.
- Появление **federation/мульти-релейности** — до этого «децентрализация» не даёт устойчивости к отказу/цензуре внутри community.
- Подписанные бинарники и более полная документация.

**Чего не делать сейчас:** не мигрировать production-репозитории и чувствительные обсуждения (git-интеграция ранняя, не заменяет зрелые PR-review/permissions/enterprise-admin GitHub); не полагаться на «децентрализацию» как гарантию доступности; не рассчитывать на семантический поиск/RAG «из коробки».

## Caveats

- **Ранний продукт.** Данные о версиях и функциях меняются быстро; перед внедрением сверяйтесь с актуальным репозиторием. На момент исследования — alpha (десктоп v0.4.21 в день запуска, затем v0.4.22).
- **Факты vs выводы.** Технические детали (kind'ы, крейты, пайплайн, лимиты, env-переменные) взяты из файлов репозитория (README.md, ARCHITECTURE.md, NOSTR.md, VISION*.md, AGENTS.md) и блога Block. Сравнения с альтернативами и часть кейсов — экспертная интерпретация автора отчёта.
- **Непокрытые/недокументированные области** (о них честно): точный формат файла персоны и схема «команды»; версионирование canvas'ов; offline/CRDT-синхронизация; точный env-var модели для `buzz-agent`; точная строка провайдера Anthropic.
- **Расхождения в источниках.** ARCHITECTURE.md в одном месте описывает Typesense как поисковый сервис, в другом (и в AGENTS.md/README) — Postgres FTS; актуальной считается Postgres FTS. Число звёзд/форков в разных срезах страницы отличается (кэш GitHub): 7 600+ за три дня (Rohit Raj), ~13,2 тыс. в более позднем срезе основной страницы.
- **Связанные проекты Block/Nostr** (goose, Damus, White Noise, NIP-спецификации) привлечены как контекст; Buzz не использует MLS/NIP-EE, в отличие от White Noise.