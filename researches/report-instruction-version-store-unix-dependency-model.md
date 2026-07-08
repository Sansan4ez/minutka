# Report: зачем `ecom1-process-architect` хранит все версии инструкций и как это похоже на зависимости в Python/Unix

- **Дата:** 2026-07-08
- **Источник:** `/home/admin/repo/ecom1-process-architect`
- **Контекст:** анализ применимости для `time-agent` / «Минута»

---

## 1. Короткий вывод

Да, гипотеза верная: в `ecom1-process-architect` хранение многих версий файлов-инструкций одновременно связано не только с историей изменений, но и с **runtime-выбором совместимой версии инструкции под конкретное состояние мира**.

Это действительно похоже на установку и использование разных версий библиотек:

- в Python: разные версии пакетов под разные constraints / virtualenv / lockfile;
- в Unix/Linux: filesystem hierarchy + package manager + dynamic linker + `/etc`, `/bin`, `/proc`;
- особенно похоже на Nix store: много immutable версий лежат рядом, а resolver выбирает нужную по зависимостям.

Главная аналогия:

> Instruction unit в `ecom1-process-architect` — это как пакет/библиотека. Его `manifest.json` — как package metadata. Его `dependencies` — как constraints. Его `dependency_snapshot/` — как lock/snapshot upstream-источников. Resolver — как dependency solver/runtime linker. Task directory — как isolated environment / virtualenv.

Для `time-agent` на MVP всё это пока можно упростить до git + Markdown + registry, потому что у нас нет автономного PA, параллельного исполнения многих world states и hash-based runtime selection.

---

## 2. Что именно хранится в `ecom1-process-architect`

Каждый instruction unit хранится так:

```text
instructions/units/<unit_id>/vNNNN/
  content.md
  manifest.json
  changes.md
  diff.patch
  dependency_snapshot/
```

Пример unit-ов:

- `bp_checkout` — 8 версий;
- `bp_submission_terminal` — 11 версий;
- `bp_refs` — 14 версий;
- `bp_index` — 11 версий;
- `executor_core` — 18 версий.

Типичный `manifest.json` содержит:

```json
{
  "unit_id": "bp_checkout",
  "version": "v0008",
  "parent": "v0007",
  "status": "active",
  "created_at": "...",
  "created_by": "process_architect",
  "mode": "failure_fix",
  "trigger": {...},
  "rationale": "...",
  "dependencies": [
    {
      "kind": "workspace",
      "path": "/docs/checkout.md",
      "sha256": "...",
      "why": "..."
    }
  ],
  "rollback": {...}
}
```

---

## 3. Зачем хранить много версий одновременно

## 3.1 Не только история, но и совместимость с состоянием мира

В обычном git-подходе старая версия нужна в основном для истории:

```bash
git show <commit>
git revert <commit>
```

В `ecom1-process-architect` старая версия нужна ещё и как **runtime candidate**.

Resolver делает примерно следующее:

1. Берёт все active версии unit-а.
2. Идёт от новой к старой.
3. Проверяет dependencies по `sha256` против текущего trial dump.
4. Выбирает первую версию, чьи зависимости совпали.
5. Если ни одна не совпала — берёт latest fallback и помечает unit как stale.

То есть несколько версий могут лежать одновременно, потому что разные версии инструкции могут быть совместимы с разными состояниями мира.

Аналогия:

```text
bp_checkout/v0006 совместим с миром A
bp_checkout/v0007 совместим с миром B
bp_checkout/v0008 совместим с миром C
```

Если текущий trial похож на мир B, resolver может выбрать `v0007`, даже если `v0008` новее.

## 3.2 Параллельные task_dir не должны ломаться от новых версий

Каждый trial получает свой `task_dir` с уже выбранными и отрендеренными инструкциями:

```text
run/task-001/
  CLAUDE.md
  business_processes/*.md
  .logs/instruction-selection.json
```

Если Process Architect в это время выпускает новую версию `bp_checkout/v0009`, уже запущенный task не должен внезапно начать читать другую инструкцию.

Поэтому версии immutable:

- запущенный Executor работает с тем, что было отрендерено в его task_dir;
- новые trials могут выбрать новую версию;
- старые task_dir остаются воспроизводимыми.

Это похоже на virtualenv или container image: запущенное окружение не меняется от того, что где-то вышла новая версия пакета.

## 3.3 Нужен replay и audit

После провала Process Architect анализирует:

- какую версию unit-а читал Executor;
- какие dependencies были зафиксированы;
- какой diff привёл к этой версии;
- почему версия была создана.

Для этого нужны старые версии как реальные файлы, а не только git history. PA workdir получает `selected-instructions/` и `version-history/`, чтобы модель могла читать все нужные версии без доступа к git-командам и без риска выйти за sandbox.

## 3.4 Нужен rollback не как git-операция, а как новая версия

В production-like agent system rollback часто делают не переписыванием истории, а созданием новой версии:

```text
v0008 bad
v0009 rollback-to-v0007-content
```

Так сохраняется audit trail:

- bad version остаётся видимой;
- rollback имеет rationale;
- resolver видит новый active candidate;
- отчёты и task_dir остаются воспроизводимыми.

Это похоже на package repository: старый плохой пакет не обязательно исчезает, но его можно retire/deprecate и выпустить новую версию.

## 3.5 Нужен conflict/rebase между параллельными PA jobs

В репозитории есть PA queue и conflict mode. Несколько PA-задач могут почти одновременно пытаться изменить один unit или связанные units.

Поэтому `base_version` фиксируется явно:

```json
{
  "unit_id": "bp_refs",
  "base_version": "v0013"
}
```

Если пока PA думал, кто-то уже выпустил `v0014`, orchestrator может обнаружить stale-base conflict и запустить conflict retry.

Это очень похоже на git rebase, но поверх versioned instruction store.

---

## 4. Почему много файлов, а не один Markdown с frontmatter

Технически можно было бы хранить всё в одном файле:

```md
---
version: v0008
parent: v0007
dependencies: ...
rationale: ...
rollback: ...
---

# Checkout process
...
```

Но для `ecom1-process-architect` это хуже по нескольким причинам.

## 4.1 Разные потребители читают разные части

Есть несколько потребителей:

| Потребитель | Что ему нужно |
|---|---|
| Executor | Только `content.md`, без служебной metadata |
| Resolver | `manifest.json`, dependencies, status |
| PA | `content.md`, `changes.md`, `diff.patch`, history |
| Validator | machine-readable decision + manifest/dependencies |
| Human reviewer | `changes.md`, `diff.patch`, rationale |
| Audit/report | manifest + generated selection logs |

Если всё хранить в одном Markdown, каждому потребителю пришлось бы парсить и фильтровать лишнее.

Отдельные файлы дают clean separation:

- `content.md` — чистая инструкция для агента;
- `manifest.json` — строгая metadata для кода;
- `changes.md` — человекочитаемый changelog;
- `diff.patch` — готовый patch для review;
- `dependency_snapshot/` — bytes источников.

## 4.2 JSON лучше для строгой машинной валидации

`manifest.json` валидируется кодом:

- есть ли `unit_id`;
- существует ли `base_version`;
- допустим ли `kind` dependency;
- есть ли `sha256`;
- не отсутствует ли required dependency;
- active/retired status.

Markdown frontmatter удобен для человека, но хуже как строгий interface между PA LLM и deterministic orchestrator.

С учётом уже принятого в наших memory/документах принципа: machine-readable artifacts лучше держать в JSON, а detailed requirements — в Markdown с frontmatter только когда нужна человекочитаемость. В ECOM `manifest.json` — именно machine-readable artifact.

## 4.3 `dependency_snapshot/` невозможно удобно положить во frontmatter

`dependency_snapshot/` хранит не metadata, а содержимое upstream-файлов:

```text
dependency_snapshot/
  workspace/docs/checkout.md
  bin-help/checkout.help.txt
  sql-table/payments.schema.txt
```

Это нужно, чтобы позже построить точный diff:

```text
old dependency bytes vs current live dependency bytes
```

Frontmatter здесь не подходит: snapshot может быть большим, бинарным/текстовым, многофайловым.

## 4.4 `diff.patch` — производный артефакт review, а не часть инструкции

`diff.patch` не нужен Executor-у. Он нужен:

- человеку;
- PA;
- отчётам;
- быстрому сравнению версий.

Если держать patch внутри Markdown, Executor может случайно увидеть неактуальный или шумный контекст. Отдельный файл позволяет не подмешивать diff в runtime prompt.

## 4.5 Atomic write проще на уровне директории

`versioning.py` пишет новую версию так:

1. создаёт `.tmp-vNNNN/`;
2. пишет `content.md`, `manifest.json`, `changes.md`, `diff.patch`, snapshots;
3. атомарно переименовывает `.tmp-vNNNN` → `vNNNN`.

Resolver никогда не увидит полузаписанную версию.

С одним Markdown-файлом это тоже возможно, но сложнее, если нужно вместе атомарно обновить content, metadata, diff и snapshots.

---

## 5. Аналогия с Python dependencies

## 5.1 Instruction unit как Python package

| ECOM | Python |
|---|---|
| `bp_checkout/v0008` | `checkout-agent-process==0.0.8` |
| `manifest.json` | `METADATA`, `pyproject.toml`, wheel metadata |
| `dependencies[]` | `Requires-Dist`, version constraints |
| `sha256` dependency | pinned exact artifact hash |
| `dependency_snapshot/` | lockfile / vendored source / wheel cache |
| Resolver | pip/poetry/uv dependency resolver |
| task_dir | virtualenv / isolated environment |
| active/retired | yanked/deprecated package release |
| PA conflict rebase | dependency conflict / resolver backtracking |

## 5.2 Почему могут быть нужны разные версии одновременно

В Python нормально иметь:

```text
project-A/.venv uses pydantic==2.8
project-B/.venv uses pydantic==2.12
```

Потому что разные проекты имеют разные constraints.

В ECOM аналогично:

```text
trial-A world deps match bp_checkout/v0006
trial-B world deps match bp_checkout/v0008
```

Разные trials или разные benchmark worlds могут требовать разных версий instruction unit.

## 5.3 Lockfile vs manifest/dependency snapshot

В Python lockfile фиксирует конкретные версии и hashes зависимостей:

```text
uv.lock
poetry.lock
requirements.txt --hash
```

В ECOM `manifest.json` + `dependency_snapshot/` фиксируют:

- от каких files/docs/bin-help/schema зависела инструкция;
- какие у них были hashes;
- какие exact bytes были на момент создания версии.

То есть это не просто «зависимость от `/docs/checkout.md`», а зависимость от конкретной версии `/docs/checkout.md`.

---

## 6. Аналогия с Unix/Linux OS

## 6.1 Unix-like верхний уровень мира

В BitGN/ECOM среда похожа на маленькую Unix-систему:

```text
/AGENTS.md  # локальные правила
/docs       # политики бизнеса
/proc       # состояние мира
/bin        # разрешённые утилиты
```

Это напоминает Unix FHS:

```text
/etc        # конфигурация и политики
/proc       # состояние kernel/process runtime
/bin        # базовые исполняемые команды
/usr        # shared read-only resources
/var        # mutable state/logs
```

В `time-agent` мы предложили аналогичный logical namespace:

```text
/AGENTS.md  # core + selected process files
/docs       # product docs, policies, agent manual
/proc       # profile, consent, memory, insights, feedback
/bin        # typed use cases/tools/CLI commands
```

## 6.2 Instruction Store как package repository

В Unix/Linux пакеты устанавливаются и хранят metadata:

```text
/var/lib/dpkg/status
/var/lib/rpm/
/usr/bin/...
/usr/lib/...
```

Package manager знает:

- какая версия установлена;
- какие зависимости;
- какие файлы принадлежат пакету;
- как откатить/обновить;
- какие пакеты conflict/provide/replace друг друга.

В ECOM Instruction Store выполняет похожую роль:

- хранит версии instruction units;
- знает parent/status/dependencies;
- умеет выбрать совместимую версию;
- сохраняет историю и rationale;
- поддерживает retirement/rollback через новые версии.

## 6.3 Resolver как dynamic linker / package manager

В Unix есть несколько уровней dependency resolution:

1. **Package manager** решает, какие версии пакетов установить.
2. **Dynamic linker** решает, какие shared libraries загрузить при запуске.
3. **Shell PATH** решает, какой executable будет вызван.
4. **Config precedence** решает, какие правила применяются.

В ECOM resolver похож на package manager + linker:

- читает registry;
- проверяет dependencies;
- выбирает совместимую версию;
- материализует runtime environment в `task_dir`.

`task_dir` похож на chroot/container/virtualenv:

```text
task_dir/
  CLAUDE.md
  business_processes/*.md
  vault/
  bin-help/
  attention/
  .logs/
```

Executor работает внутри этого подготовленного окружения.

## 6.4 Immutable store и Nix-подобная модель

Самая близкая Unix-like аналогия — не классический apt, а Nix:

```text
/nix/store/<hash>-package-version/
```

В Nix:

- разные версии пакетов лежат одновременно;
- пути immutable;
- зависимости content-addressed;
- environment/profile выбирает, что именно видно процессу;
- rollback — переключение profile на предыдущую closure.

В ECOM:

```text
instructions/units/bp_checkout/v0008/
```

- версии immutable;
- dependencies зафиксированы hashes;
- resolver выбирает closure instruction units;
- task_dir получает выбранную closure;
- rollback — новая версия или выбор older compatible version.

Разница: ECOM store не content-addressed по пути как Nix; версия — `vNNNN`, а hashes живут внутри manifest.

## 6.5 `/proc` и live state

В Unix `/proc` — текущая runtime-проекция состояния kernel/processes. Это не source code и не config.

В ECOM `/proc` — состояние магазина: продукты, корзины, платежи, пользователи, заказы.

В `time-agent` `/proc` логически может быть:

```text
/proc/profile/<employeeId>
/proc/consent/<employeeId>
/proc/thread/<threadId>
/proc/insights/<employeeId>
/proc/feedback/<responseId>
```

Это не обязательно реальные файлы. Это stable read model, который может быть реализован через Application services, SQLite/Postgres, HTTP/RPC endpoints или CLI.

## 6.6 `/bin` как capability boundary

Unix `/bin` — это набор разрешённых commands. В ECOM агент действует через `/bin/*` и controlled `execute_python`.

В `time-agent` `/bin`-аналог:

```text
/bin/update-profile
/bin/extract-insights
/bin/record-feedback
/bin/generate-automation-map
```

Физически это могут быть:

- TS application use cases;
- Mastra tools;
- CLI commands;
- HTTP endpoints;
- MCP tools.

Главное: агент видит стабильные capabilities, а не произвольный доступ к storage.

---

## 7. Бизнес-кейсы для multi-version рабочих инструкций

Много активных версий инструкций нужно не каждому бизнесу. Подход оправдан, когда инструкция является не просто текстом, а **операционным артефактом**, применимость которого зависит от клиента, договора, даты, региона, версии продукта, rollout-группы или регуляторного режима.

Короткий список бизнес-кейсов:

| Кейс | Зачем нужны разные версии инструкций |
|---|---|
| **Банк: KYC / AML / onboarding** | Проверки зависят от юрисдикции, типа клиента, risk level и версии регуляторных требований. Старые клиенты могут жить по transitional rules. |
| **Страхование: claims processing** | Условия выплат зависят от версии полиса, даты заключения договора, страхового продукта и региона. Нельзя применять текущие правила к старому полису без проверки. |
| **E-commerce: возвраты, гарантия, скидки** | Заказы до и после изменения политики обслуживаются по разным правилам. Дополнительно влияют тип товара, клиентский сегмент и канал продажи. |
| **B2B SaaS support / incident response** | У клиентов разные SLA, escalation matrix, business hours, contract tier и доступные интеграции. Один support-agent должен выбирать клиентский process. |
| **HR: отпуска, компенсации, льготы** | Правила зависят от страны, типа договора, даты найма, подразделения и версии compensation/benefits policy. |
| **Налоги и бухгалтерия** | Налоговые правила версионированы по отчётному периоду. Отчёты за 2024, 2025 и 2026 могут требовать разных процессов. |
| **Медицина: clinical protocols** | Протоколы зависят от страны, учреждения, специализации, оборудования и версии guideline; нужен строгий audit, какая инструкция применялась. |
| **Производство: SOP / quality control** | Процедуры зависят от линии, оборудования, партии, версии продукта и стандарта качества. Старые линии могут работать по старым SOP. |
| **Франчайзинг / сеть филиалов** | Филиалы в разных странах или на разных стадиях внедрения используют разные операционные модели и локальные правила. |
| **Корпоративное обучение / «Минута»** | Разные клиенты могут иметь разные privacy agreements, цели программы, отраслевые категории автоматизации и версии методологии. |
| **A/B и staged rollout процессов** | Новая версия сценария может раскатываться на pilot/canary-группу, пока остальные пользователи остаются на старой. |

Общее правило выбора архитектуры:

| Ситуация | Что достаточно |
|---|---|
| Один продукт и один набор правил | Git + Markdown process files |
| Нужны история, diff и rollback, но одна active версия | Git tags/releases |
| Разные клиенты/периоды/договоры требуют ручного выбора | Git branches/profiles или config-based selection |
| Runtime должен сам выбирать процесс по контексту | Versioned instruction store + resolver |
| Нужен exact replay / regulatory audit | Selected version logs + snapshots |
| Policies приходят извне и меняются вне git | Dependency hashes + snapshots |

Для `time-agent` это означает: multi-version store может понадобиться позже, если появятся разные активные policy worlds: например, банк-клиент со строгой privacy policy, строительная компания с отраслевой картой автоматизации, пилот новой методологии и старый поток, который нельзя переключать посреди программы.

---

## 8. Почему этот подход не нужен полностью в `time-agent` прямо сейчас

У нас пока другие условия:

| Условие | ECOM | time-agent MVP |
|---|---|---|
| Мир часто меняется извне | Да | Пока нет |
| Много concurrent trials | Да | Нет |
| Автономный Process Architect пишет инструкции | Да | Нет |
| Нужно выбирать older compatible instruction at runtime | Да | Пока нет |
| Все product docs в одном git repo | Не всегда | Да |
| Human-in-loop review | Ограниченно | Да |

Поэтому для `time-agent` сейчас достаточно:

```text
docs/agent-manual/
  registry.json
  core.md
  author-contract.md
  processes/*.md
```

И git даёт:

- history;
- parent;
- diff;
- rollback;
- blame;
- review;
- tags.

Полный store понадобится позже, если появится хотя бы одно из условий:

1. разные клиенты имеют разные policy worlds;
2. process-файлы обновляет автономный PA;
3. один runtime должен одновременно обслуживать разные версии manual;
4. docs/policies приходят из remote endpoints и меняются вне git;
5. нужен exact replay: «какую инструкцию агент видел при этом ответе месяц назад»;
6. нужно hash-based detection, что process устарел относительно политики.

---

## 9. Рекомендация для `time-agent`

## Сейчас

Использовать git-first подход:

```text
docs/agent-manual/
  registry.json
  core.md
  author-contract.md
  processes/
    index.md
    onboarding.md
    consent_and_privacy.md
    evening_reflection.md
    workday_guardrails.md
    insight_extraction.md
    feedback.md
```

В каждом process-файле:

```md
## Dependencies

- `docs/product/agent-minutka-brief.md` — почему важно.
- `docs/product/virtual-simulation.md` — почему важно.
- `docs/plans/time-agent-mastra-plan.md` — почему важно.
```

В `registry.json`:

```json
{
  "processes": [
    {
      "id": "evening_reflection",
      "path": "processes/evening_reflection.md",
      "kind": "business_process",
      "dependsOn": [
        "docs/product/agent-minutka-brief.md",
        "docs/product/virtual-simulation.md"
      ]
    }
  ]
}
```

## Позже

Добавлять по мере боли:

1. `agent-manual:check` — проверка dependencies и обязательных секций.
2. `selectedProcessIds` в audit.
3. `prompt-preview.md` для manual smoke/eval.
4. hash check для dependencies.
5. versioned instruction store только если понадобится runtime selection разных версий.

---

## 10. Финальная формулировка

В `ecom1-process-architect` версии instruction files хранятся одновременно потому, что они являются не просто историей текста, а **installable runtime artifacts**. Resolver выбирает версию инструкции как dependency solver выбирает версию библиотеки: по совместимости с текущим миром и зависимостями.

Отдельные файлы вместо одного Markdown-frontmatter нужны потому, что unit — это пакет, а не статья:

- `content.md` — runtime payload;
- `manifest.json` — machine-readable package metadata;
- `changes.md` — human changelog;
- `diff.patch` — review artifact;
- `dependency_snapshot/` — locked upstream source bytes.

Ближайшая системная аналогия — Python packages + lockfiles + virtualenv, а ещё точнее — Unix/Nix-подобная модель immutable store + resolver + isolated runtime environment.

Для `time-agent` на MVP достаточно git-first Agent Manual. Полную package-store модель стоит вводить только когда появится необходимость одновременно обслуживать разные версии instruction processes или автоматически подбирать их под разные policy worlds.
