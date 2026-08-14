# Минутка

«Минутка» — сервис диагностики рутин сотрудников (Telegram-first, мультитенантный: компания → учебная группа → сотрудник → должность). Рабочий **прототип**: цель — лёгкая, простая, быстрая и потому надёжная архитектура. Построен на Mastra + TypeScript.

Репозиторий — **клон репозитория персонального ассистента** (`git@github.com:Sansan4ez/personal-assistant.git`, remote `assistant`), сделанный по [RFC линейки из трёх продуктов](docs/architecture/rfc-three-products-implementation.md) §2.2. Продукт строится на живом agent-led-рантайме ассистента; legacy-чат-контур «Минутки» (`MinutkaService.chat()`, `ConversationDecisionRouter`, legacy-manual) **не реанимируется** и служит только референсом формулировок. Ассистентские фичи, не нужные «Минутке», удаляются по мере развития — перечень определяют эпики в этом трекере.

**Целевая архитектура:** [docs/architecture/rfc-minutka-tenancy-and-reporting.md](docs/architecture/rfc-minutka-tenancy-and-reporting.md) (мультитенантная ось, dual-write обезличенного следа, правило ≥5, retention «до отчёта») поверх унаследованного рантайма: [rfc-personal-assistant-architecture.md](docs/architecture/rfc-personal-assistant-architecture.md) + [rfc-agent-led-routing.md](docs/architecture/rfc-agent-led-routing.md) (агент сам роутит по процессам в один ход — не пре-флайт-роутер).

## Слои

Поток: `Telegram / HTTP / CLI → AssistantService → typed use-cases → stores`. Агент не пишет в stores напрямую и не выполняет внешние действия без подтверждения.

- [`src/domain/`](src/domain) — чистые доменные типы (без зависимостей).
- [`src/contracts/`](src/contracts) — zod-DTO транспортной границы.
- [`src/application/`](src/application) — оркестрация, порты stores, in-memory адаптеры, проекции.
- [`src/mastra/`](src/mastra) — агенты, инструменты, runtime-мост Mastra.
- [`src/infrastructure/`](src/infrastructure) — PostgreSQL/MinIO адаптеры.
- [`src/server/`](src/server), [`src/telegram/`](src/telegram), [`src/client/`](src/client) — транспорты (HTTP API, Telegram-бот, CLI).
- [`src/runtime/`](src/runtime), [`src/config/`](src/config), [`src/shared/`](src/shared) — сборка runtime, конфиг, утилиты.

## Ключевые папки

- [`docs/`](docs) — [`architecture/`](docs/architecture) (RFC), [`CONVENTIONS.md`](docs/CONVENTIONS.md) (правила доков), [`plans/`](docs/plans) ([индекс](docs/plans/README.md); планы ведутся **эпиками в `br`**, папка держит только шаблон/README/TODO), [`product/`](docs/product) (бриф), [`runbooks/`](docs/runbooks).
- [`vault/`](vault) — Agent Vault: [`assistant/`](vault/assistant) — роль ([`AGENTS.md`](vault/assistant/AGENTS.md)), навыки [`processes/`](vault/assistant/processes), typed-действия [`bin/`](vault/assistant/bin), проекции `proc/`. Приватного `vault/user/` владельца ассистента в клоне нет и он сюда не переносится.
- [`specs/`](specs) — executable specs ([`executable/`](specs/executable)), [`persistence/`](specs/persistence), [`smoke/`](specs/smoke). Гоняются без LLM/сети через in-memory адаптеры.
- [`migrations/`](migrations) — SQL-миграции PostgreSQL.
- [`docs/researches/`](docs/researches) — исследовательские отчёты и RFC.

## Команды

```bash
npm run typecheck      # tsc --noEmit
npm run specs          # executable specs (без сети)
set -a; . ./.env; set +a
npm run specs:persistence # executable specs for storage
MINIO_SMOKE=true npm run specs:minio # executable specs for MinIO
npm run verify         # typecheck + specs
npm run db:migrate     # применить миграции
npm run telegram:dev   # локальный Telegram-бот (polling)
```

## Планка качества пилота (review policy)

Действует [docs/architecture/rfc-pilot-quality-bar.md](docs/architecture/rfc-pilot-quality-bar.md) (документ унаследован от ассистента и описывает single-owner-контур; для «Минутки» контур пилота — сотрудники приглашённой компании по инвайтам оператора, данные не враждебны). Обязательно для всех агентов (разработка и ревью):

- **Один раунд ревью на эпик + один integration gate.** Повторный раунд — только по явному решению оператора; агент не открывает его сам.
- **Триаж каждой находки одним вопросом:** нарушает красную линию (изоляция `userId`; вторая ось изоляции company/group и правила видимости из [RFC «Минутки»](docs/architecture/rfc-minutka-tenancy-and-reporting.md) §2.3–2.4; запись только через typed use-cases; подтверждение внешних действий; сохранность durable-данных; секреты) или ломает пилотный сценарий? Да → задача в эпике. Нет → P3/P4 в post-pilot backlog, фазу не блокирует.
- **Каждая задача называет misfit.** Задача, пришедшая не от живого тестировщика, заводится только со ссылкой на конкретное расхождение с уже записанным assumption — пункт RFC, брифа, процесса или код. «Было бы правильнее» и «понадобится потом» — не основание; такие задачи заводит только оператор.
- **Вне скоупа до пересмотра планки:** Unicode smuggling, prompt-injection через собственные данные владельца, multi-instance гонки, fail-closed на каждой внутренней границе, allow-list'ы model-visible полей (кроме секретов).
- **DoD фазы:** продуктовый сценарий работает end-to-end + `npm run verify` зелёный + красные линии. «Аудит не нашёл замечаний» в DoD не входит.
- Уже написанную защитную обвязку не удалять и не наращивать; упрощения — в post-pilot cleanup этого репозитория (`prs-zgo` — задача репозитория ассистента, здесь её нет).

## Ограничения на тяжёлые операции

Без явного разрешения пользователя **не запускать**:

- `nix search`
- `nix eval`
- `nix run`
- `nix shell`

<!-- bv-agent-instructions-v2 -->

---

## Beads Workflow Integration

This project uses [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br`) for issue tracking and [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) (`bv`) for graph-aware triage. Issues are stored in `.beads/` and tracked in git.

### Using bv as an AI sidecar

bv is a graph-aware triage engine for Beads projects (.beads/beads.jsonl). Instead of parsing JSONL or hallucinating graph traversal, use robot flags for deterministic, dependency-aware outputs with precomputed metrics (PageRank, betweenness, critical path, cycles, HITS, eigenvector, k-core).

**Scope boundary:** bv handles *what to work on* (triage, priority, planning). `br` handles creating, modifying, and closing beads.

**CRITICAL: Use ONLY --robot-* flags. Bare bv launches an interactive TUI that blocks your session.**

#### The Workflow: Start With Triage

**`bv --robot-triage` is your single entry point.** It returns everything you need in one call:
- `quick_ref`: at-a-glance counts + top 3 picks
- `recommendations`: ranked actionable items with scores, reasons, unblock info
- `quick_wins`: low-effort high-impact items
- `blockers_to_clear`: items that unblock the most downstream work
- `project_health`: status/type/priority distributions, graph metrics
- `commands`: copy-paste shell commands for next steps

```bash
bv --robot-triage        # THE MEGA-COMMAND: start here
bv --robot-next          # Minimal: just the single top pick + claim command

# Token-optimized output (TOON) for lower LLM context usage:
bv --robot-triage --format toon
```

#### Other bv Commands

| Command | Returns |
|---------|---------|
| `--robot-plan` | Parallel execution tracks with unblocks lists |
| `--robot-priority` | Priority misalignment detection with confidence |
| `--robot-insights` | Full metrics: PageRank, betweenness, HITS, eigenvector, critical path, cycles, k-core |
| `--robot-alerts` | Stale issues, blocking cascades, priority mismatches |
| `--robot-suggest` | Hygiene: duplicates, missing deps, label suggestions, cycle breaks |
| `--robot-diff --diff-since <ref>` | Changes since ref: new/closed/modified issues |
| `--robot-graph [--graph-format=json\|dot\|mermaid]` | Dependency graph export |

#### Scoping & Filtering

```bash
bv --robot-plan --label backend              # Scope to label's subgraph
bv --robot-insights --as-of HEAD~30          # Historical point-in-time
bv --recipe actionable --robot-plan          # Pre-filter: ready to work (no blockers)
bv --recipe high-impact --robot-triage       # Pre-filter: top PageRank scores
```

### br Commands for Issue Management

```bash
br ready              # Show issues ready to work (no blockers)
br ready --epic <id>  # Show ready executable descendants of an epic
br list --status=open # All open issues
br show <id>          # Full issue details with dependencies
br create --title="..." --type=task --priority=2
br update <id> --claim # Atomically claim an issue and mark it in_progress
br close <id> --reason="Completed"
br close <id1> <id2>  # Close multiple issues at once
br sync --flush-only  # Export DB to .beads/issues.jsonl
```

### Workflow Pattern

1. **Triage**: Run `bv --robot-triage` to find the highest-impact actionable work.
2. **Inspect**: Run `br show <id>` and inspect dependencies before implementation.
3. **Decompose**: Treat `epic` as a container. Run executable child issues; if an epic has no children, decompose it before implementation.
4. **Claim**: Use `br update <id> --claim`. The sequential orchestrator performs this after the worker readiness signal.
5. **Work**: Implement only the claimed issue and run focused verification.
6. **Complete**: Run `br close <id> --reason="..."`, then `br sync --flush-only`.
7. **Commit**: Create exactly one local atomic commit for the issue, including the related `.beads/issues.jsonl` change.
8. **Review and publish**: The operator reviews the complete local commit series and performs `git push` explicitly; workers and the orchestrator do not push.

### Key Concepts

- **Dependencies**: Issues can block other issues. `br ready` shows only unblocked work.
- **Priority**: P0=critical, P1=high, P2=medium, P3=low, P4=backlog (use numbers 0-4, not words).
- **Types**: task, bug, feature, chore, and docs are executable when their scope is concrete. Epic is a container and must not be implemented as one worker task. Question must be resolved or converted to an executable issue before orchestration.
- **Blocking**: `br dep add <issue> <depends-on>` adds dependencies.
- **Source of truth**: Scope and status live in `br`; implementation and the synchronized `.beads/issues.jsonl` live in the same Git commit.

### Git Boundary for Agent Work

```text
worker       → one local atomic commit per issue
orchestrator → verify commit and clean worktree
operator     → review the complete commit series, then push explicitly
```

Worker requirements:

- do not start from or overwrite unrelated dirty changes;
- keep all implementation, tests, docs, and `.beads/issues.jsonl` updates for one issue in one commit;
- include the exact `br` issue ID in the commit message;
- stage only files related to the issue; do not use broad staging when unrelated files may exist;
- do not amend or rewrite commits created for earlier issues;
- do not run `git push`;
- finish with a clean worktree.

Sequential orchestrator requirements:

- require a clean worktree before the sequence and before every issue;
- record `HEAD` before launching a worker;
- continue only when the issue is closed, the worker exits successfully, and exactly one new commit exists;
- verify that the commit message contains the issue ID and that `.beads/issues.jsonl` is included;
- verify that the worktree is clean before launching the next issue;
- stop on any failed invariant and leave publishing to the operator;
- print the exact `base..HEAD` commit range for operator review after a successful sequence.

Operator review and publish protocol:

```bash
git status --short                    # Must be clean before orchestration
base="$(git rev-parse HEAD)"          # Save before starting the sequence
# run the sequential orchestrator
git log --oneline "$base"..HEAD       # Review one commit per issue
git diff --stat "$base"..HEAD
git diff "$base"..HEAD               # Review the complete local series
git push                              # Only after explicit operator approval
```

### After task implementation

- close the task in `br` and run `br sync --flush-only`;
- create exactly one local atomic commit with the task ID in its message;
- include `.beads/issues.jsonl` in that same commit;
- leave the worktree clean and define the next step/task;
- do not push unless the operator explicitly requests it after reviewing the series.

<!-- end-bv-agent-instructions -->
