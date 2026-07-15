# Исправление роутинга и каталога процессов (F1–F8)

> ⚠️ **SUPERSEDED (2026-07-15) — [rfc-agent-led-routing.md](../architecture/rfc-agent-led-routing.md).** Проект переходит на агент-ведомый роутинг (агент сам выбирает процессы в один ход, без пре-флайт-LLM-роутера и TS-слоя форсинга). Большинство дефектов F1–F8 — техдолг именно этой машинерии и **растворяется** вместе с ней, а не выполняется: **F2 больше не предшественник Фазы B**, F3 (оба роутера удаляются, а не сводятся к одному), F6 (порядок задаёт агент/индекс). Остаются как дешёвая гигиена: **F1** (`/docs` не заявлять runtime-входом), **F4** (точное privacy-правило в `AGENTS.md`/`privacy-boundary.md`). F5/F7/F8 пересматриваются в новой модели по мере фаз. Таблица соответствия — §6 нового RFC. Ниже — исходный план, оставлен для провенанса.

> **Источник:** ревью Agent Vault «Минутки» ([routing-error.md](../../routing-error.md)), проверенное на текущем репозитории 2026-07-15.
> **Зачем в рамках ассистента:** [rfc-personal-assistant-architecture.md](../architecture/rfc-personal-assistant-architecture.md) §8 требует переиспользовать этот же механизм (registry + decision router + allow-list) и расширить триггеры (`scheduled`, `file_uploaded`). Найденные дефекты наследуются ассистентом; часть — жёсткие блокеры фаз.
> **Статус:** proposed. F2 — предшественник [Фазы B](./phase-b-idea-bank.md).

---

## 0. Рамка и приоритизация

Все восемь замечаний **подтверждены в текущем коде** (не только в «Минутке» — это один репозиторий). При этом `AssistantService` (Фаза A) пока **не подключает** loader/router/manual: `chat` зовёт `agentRunner` напрямую. Значит, дефекты сегодня живут в слое «Минутки», но ассистент унаследует их, как только выбор навыков будет подключён в `AssistantService` (Фазы B–C).

Приоритет — **не по severity ревью, а по фазе ассистента, которая дефект наследует**:

| Приоритет | Пункты | Когда делать | Почему тогда |
|---|---|---|---|
| P1 | **F2** (обязательно), F3, F1 | Один «cleanup»-заход **до Фазы B** | F2 — жёсткий блокер B; F3/F1 дёшевы и в том же коде |
| P2 | F6, F4 | Вместе с **Фазой C** | Manual реально подключается в `AssistantService` на C |
| P3 | F5 | Вместе с **Фазой G** | Insight-extractor всплывает у ассистента на `context_insights` |
| P4 | F8 (+F7) | Гигиенический хвост | Защита от повторного drift; F7 закрывается внутри F8 |

**Единственный жёсткий предшественник Фазы B — F2.** Без него `assertPurpose` бросит на `file_uploaded`, а хардкод-каталог не примет id `inbox_capture`. F3 и F1 идут в тот же заход по удобству, а не по необходимости.

---

## 1. Перечень дефектов (подтверждено, с текущими строками)

| # | Дефект | Доказательство (файл:строки на 2026-07-15) |
|---|---|---|
| F1 | `/docs` объявлен runtime-контуром, но не грузится и не рендерится | loader: `src/application/agent-manual-loader.ts:59-82`; render: `src/application/agent-manual-resolver.ts:188-208`; вход-контракт: `vault/processes/consent_and_privacy.md:11`; противоречие: `vault/docs/README.md:5` (запрет планов) vs `consent_and_privacy.md:11,46-47` (ссылки на планы) |
| F2 | registry — не source of truth для process ids; список продублирован и захардкожен | `src/application/agent-manual-types.ts:42-50`; `src/domain/conversation-decision.ts:3-10`; `src/mastra/conversation-decision-router.ts:10-18`; отвергает неизвестный id: `agent-manual-loader.ts:189-194`; захардкожены purpose: `agent-manual-loader.ts:196-201` |
| F3 | Два конкурирующих decision router-а | старый: `src/mastra/agents/agent-manual-router-agent.ts`, `src/mastra/agent-manual-router.ts`; зарегистрирован `src/mastra/index.ts:4,18`; подключён `src/runtime/create-in-memory-runtime.ts:27`, опционален `src/application/minutka-service.ts:99,132`; новый (prod): `src/mastra/runtime-deps.ts:10` |
| F4 | Fallback основного агента противоречит privacy-документу | `src/mastra/agents/minutka-agent.ts:20` («не сохраняй raw transcript») vs `vault/docs/privacy-boundary.md:11` (транскрипт хранится как обычное приватное сообщение canonical history) |
| F5 | Extractor заявляет процесс источником истины, но не получает его контент | заявление: `src/mastra/agents/insight-extractor-agent.ts:12`; фактический prompt без process/systemContext: `src/mastra/insight-extractor.ts:199-223`; вызов без systemContext: `src/mastra/insight-extractor.ts:190-197` |
| F6 | Порядок выбранных process-файлов не фиксирован | рендер в порядке LLM: `src/application/agent-manual-resolver.ts:197`; санитайзер дедуплицирует, но не сортирует по precedence: `src/application/conversation-decision-router.ts` |
| F7 | Поле `Mutating` для feedback устарело | `vault/processes/index.md:16` («Future feedback record.») vs фактическое сохранение `src/application/minutka-service.ts:414` |
| F8 | Нет executable-проверки семантической синхронизации index↔registry↔код | проверяется лишь `index.includes(\`id\`)`: `src/application/agent-manual-loader.ts:149-152` |

---

## 2. P1 — «cleanup»-заход перед Фазой B

### F2. Единый canonical process catalog (registry как источник истины)

Выбран **Вариант A** ревью: реестр описывает доступные процессы без правки application-кода при добавлении markdown-навыка — это прямой смысл Agent Vault и цель RFC §2.4 («каждый навык добавляемым как process-файл + запись в реестре, без изменения ядра»).

Изменения:

1. **Один каталог.** Свести дублирующиеся списки к одному источнику. Практично: оставить `registry.json` источником runtime-значений, а в коде — производные:
   - `DecisionProcessId` перестаёт быть закрытым union из статических литералов; переходит на branded/`string`-тип, проверяемый loader’ом против registry (`src/domain/conversation-decision.ts:3-10`).
   - `agentManualProcessIds` / `requiredAgentManualProcessIds` (`agent-manual-types.ts:42-59`) строятся из registry, а не хардкодятся.
   - Router-schema (`conversation-decision-router.ts:10-18`) валидирует **структуру** и **членство в runtime allow-list** (передаётся из manual), а не статический `z.enum`.
   - `assertProcessId` (`agent-manual-loader.ts:189-194`) проверяет id против загруженного registry, а не против константы кода.
2. **Расширить `assertPurpose`** (`agent-manual-loader.ts:196-201`) триггерами RFC §8.2: добавить `scheduled` и `file_uploaded` к `chat | onboarding_first_response | feedback`. **Это разблокирует `inbox_capture` (`appliesTo: ["chat","file_uploaded"]`) из Фазы B.** Список purpose — тоже единый (перечень в одном месте, а не в loader + resolver + router).
3. **Тест-инвариант:** добавление process-файла **только** через `registry.json` проходит весь путь loader → router-schema → application-sanitizer без правок TS (сейчас отвергается на всех этих этапах).

Границы: не переписываем сам decision-контракт (workDecision/insightDecision), только источник множества id и purpose.

### F3. Один production decision plane

`conversationDecisionAgent` остаётся единственным production-роутером. Действия:

- Удалить `src/mastra/agents/agent-manual-router-agent.ts` и `src/mastra/agent-manual-router.ts` (либо, если нужен отдельный low-level компонент, явно переименовать в `processSelectionRouter` — но сейчас это дубль той же ответственности, а не вспомогательный слой).
- Снять регистрацию `agentManualRouterAgent` в `src/mastra/index.ts:4,18`.
- Убрать `agentManualRouter` из `src/runtime/create-in-memory-runtime.ts:27` и опциональной зависимости `src/application/minutka-service.ts:99,132` (или свести обе in-memory/prod композиции к одному роутеру).
- Обновить specs, чтобы они проверяли **реальную production-композицию**, а не старый роутер.

Ценность для ассистента: выбор навыков `AssistantService` (Фаза C) ляжет на один плоскость решений, без риска подключить не тот.

### F1. Судьба `/docs`

Пока `AssistantService` manual не грузит, берём **минимальный честный вариант**: зафиксировать `/docs` как developer/product-документацию, а обязательные runtime-правила держать в `AGENTS.md`/process-файлах.

- Убрать `/docs` из списка **входов** процесса в `vault/processes/consent_and_privacy.md:11` и снять из его `Dependencies` ссылки на implementation-планы (`:46-47`) — это же устраняет противоречие с `vault/docs/README.md:5`.
- В `vault/docs/README.md` уточнить, что это developer-документация, не runtime-инструкции (или, если решим грузить, — ввести явный `runtimeDocs`-механизм с selection и validation; для пилота избыточно).
- `validateAgentManual` уже требует упоминания хэндла `/docs` в `AGENTS.md` (`agent-manual-loader.ts:156`) — оставить как namespace-указатель, но без загрузки контента.

> Полноценную загрузку выбранных `/docs` в prompt вводим, когда ассистент реально начнёт использовать manual (Фаза C+), — тогда сразу с runtime-selection и тестами (Вариант 1 ревью в ограниченном виде).

**Проверяемый результат P1:** новый process-файл добавляется только через registry; `file_uploaded`/`scheduled` проходят валидацию; в проекте один decision router; specs зелёные; `/docs` не заявлен как несуществующий runtime-вход.

---

## 3. P2 — вместе с Фазой C

### F6. Детерминированный порядок и precedence

- Добавить в registry поле `order` (или `class`: `core|lifecycle|trigger|cross-cutting|mutating`) и **одну** точку сортировки перед rendering / audit / возвратом `selectedProcessIds` / сравнением в specs.
- Зафиксировать precedence как правило: `core` неоспорим; privacy/safety > persona/convenience; boundary > обычный ответ; mutation — только после решения и авторизации.
- Делать на Фазе C, т.к. именно там manual подключается в `AssistantService` и порядок начинает влиять на ответ ассистента.

### F4. Точная privacy-формулировка

- Заменить свободный текст `src/mastra/agents/minutka-agent.ts:20` на точное правило: не копировать raw transcript в insights/audit/aggregates; не хранить прямые PII в structured insights; canonical private history управляется application-слоем и не является company-visible aggregate.
- Само правило держать в `AGENTS.md`/`privacy-boundary.md`, а не дублировать в инструкции агента.
- Превентивно для ассистента: та же формулировка не должна переехать в `vault/assistant/AGENTS.md` (single-owner-модель — тем более: владелец видит всё своё, путать «хранится / видно компании» нельзя).

---

## 4. P3 — вместе с Фазой G

### F5. Extractor process-driven

- В `buildExtractionPrompt` (`src/mastra/insight-extractor.ts:199-223`) передавать отрендеренный `insight_extraction.md` + privacy-safe срез `AGENTS.md`; вызов (`:190-197`) снабдить systemContext.
- В application-слое проверять, что `selectedProcessIds` содержит `insight_extraction`, прежде чем звать extractor.
- Ограничить длины `label/rationale/interferesWith` и вычищать прямые PII до сохранения.
- Тайминг: extractor всплывает у ассистента только на `context_insights` (Фаза G).

---

## 5. P4 — гигиенический хвост

### F8. Executable validation против drift (+ F7)

Расширить `validateAgentManual` (`src/application/agent-manual-loader.ts:91-163`) минимум на:

- точное множество process ids: registry ↔ index ↔ каталог кода (после F2 — против единого источника);
- порядок registry/index (после F6 — против `order`);
- `appliesTo` каждого процесса;
- side-effect-метаданные (устраняет **F7**: `vault/processes/index.md:16` «Future feedback record.» → точная таблица owner/side-effect, т.к. feedback уже персистится `minutka-service.ts:414`);
- наличие process id в schema/domain/router (после F2 — тривиально, всё из одного источника);
- какие process-файлы реально попадают в runtime context (и, если введём загрузку `/docs`, — какие docs).

Полную семантическую сверку текстов не делаем; цель — убрать механический drift, который сейчас проходит мимо `npm run verify`.

---

## 6. Порядок работ

```
P1 (перед Фазой B):  F2  →  F3  →  F1        # один заход по shared-слою; F2 обязателен, F3/F1 по удобству
Фаза B (банк идей)                            # см. phase-b-idea-bank.md — теперь опирается на единый каталог
Фаза C (планирование):  + F6  + F4
...
Фаза G (инсайты):       + F5
Хвост:                  F8 (+ F7)
```

Каждый пункт самостоятелен и заканчивается зелёными `npm run typecheck` / `npm run specs` / `npm run verify`. F2/F3 меняют shared-код «Минутки» — прогнать существующие specs «Минутки» на регресс (роутинг, guardrails, insight-continuity).

---

## 7. Definition of Done (P1, как предшественник Фазы B)

- [ ] Единый источник process ids и purpose; `DecisionProcessId`/schema/loader/sanitizer читают его, а не хардкод.
- [ ] `assertPurpose` принимает `scheduled` и `file_uploaded` (RFC §8.2).
- [ ] Новый process-файл заводится только правкой `registry.json` — тест это доказывает (loader → schema → sanitizer).
- [ ] В репозитории один production decision router; старый удалён/переименован; specs проверяют реальную композицию.
- [ ] `/docs` не заявлен как runtime-вход в process-файлах; противоречие README↔consent устранено.
- [ ] Существующие specs «Минутки» зелёные; `npm run typecheck`, `npm run specs`, `npm run verify` проходят.
