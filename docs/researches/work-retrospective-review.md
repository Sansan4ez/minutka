# Единственный review раунд ретроспективы рабочего эпизода

Receipt `mnt-hf3h.14`. Основание: [принятый RFC, R1–R8 и §7](../architecture/rfc-routine-ontology-and-targeted-clarification.md), [pilot quality bar](../architecture/rfc-pilot-quality-bar.md). Это review текущей итоговой реализации, не повторный аудит отменённого management subsystem.

## Диапазон и verdict

```text
base 391bd17e0ad0b432fd97e6f4aa4423dd5f379621
head fc0372c279eccb46a091c1dfa4d433ffc2475ec2
range 391bd17e0ad0b432fd97e6f4aa4423dd5f379621..fc0372c279eccb46a091c1dfa4d433ffc2475ec2
```

Net diff: 126 files, 5373 insertions / 197 deletions. Implementation `.1–.12`, composition fixes `.20–.26` и runbook `.13` завершены. `.18/.19` отменены и reverted; отдельные policy state/CLI не считаются действующей архитектурой. Изменения backup/context defaults и документации в этом же диапазоне учтены как сопутствующие, не как новая продуктовая методика.

**Verdict: request changes.** Три подтверждённых finding — нарушения secret boundary, continuity factual targets и evidence invalidation. Это **P1 / High, blockers пилота**, не требования общего cleanup. Уверенность в воспроизведённых дефектах: **0.98**. Уверенность не означает доказанное отсутствие других дефектов.

| Finding | Задача исправления | Misfit | Gate |
|---|---|---|---|
| F1: raw secrets в indicator metadata | `mnt-hf3h.27` | R8, secrets вне corpus/model; RFC §4.3 | blocks `.15` |
| F2: stale activity ref после собственного correction | `mnt-hf3h.28` | R3/R4, durable revisions/короткие уточнения; §4.1–4.2 | blocks `.15` |
| F3: activity-only correction не инвалидирует checked recommendation | `mnt-hf3h.29` | R6/R8, correction/supersession invalidation; §4.3/§5 | blocks `.15` |

`.14` завершается receipt и триажем; исправления не входят в эту задачу. После fixes `.15` проверяет regression и integration, **не открывает новый review раунд**. Второй review возможен только по явному решению оператора. Живой запуск `.16` остаётся blocked до fixes, gate и private manifest/разрешений.

## F1 — санитизировать все indicator text поля

**Citation на review HEAD:** [src/application/retrospective-event-store.ts:30–34](../../src/application/retrospective-event-store.ts#L30-L34); producer [work-retrospective-request.ts:78–82](../../src/application/work-retrospective-request.ts#L78-L82).

Sanitizer обходит object properties, но применяет `sanitizeResearchText` к string values только с ключами `text`, `quote`, `statement`, `reason`. `indicator.sign/meaning/reaction` — свободный модельный текст, они остаются raw. `metadataFor` сохраняет это в canonical messages metadata; reducer при rebuild использует тот же sanitizer. Research export также вызывает его. Это не гипотетическая атака на trusted данные: сотрудник может случайно прислать credential, и runtime уже имеет конкретные правила редактирования таких строк.

- **Given:** scoped synthetic participant/group/profile и active episode; synthetic credential patterns sk-, password= и Bearer в трёх indicator полях. Реальные credentials не используются.
- **When:** request-bound `update({closeReason:"answered", indicator})`, canonical save; пересоздание stores и `readEpisodes`.
- **Actual:** canonical episode update и reconstructed episode содержат raw значения. Отдельная probe sanitizer подтверждает все три поля.
- **Expected:** credential patterns удалены существующим sanitizer перед persistence и при sanitized чтении; refs/IDs/version остаются неизменными. Контекст модели не возвращает raw indicator.
- **Направление fix:** включить indicator free-text в existing sanitization, не строить новую secret subsystem/field allow-list. Проверки `.27` охватывают metadata/rebuild/context/export и обычный indicator/replay.

Безопасный outcome probe (значения намеренно не печатаются):

```json
{"probe":"secret-metadata","rawSecretFieldsRetained":["sign","meaning","reaction"],"canonicalRawSecret":true,"rebuiltRawSecret":true}
```

## F2 — обновлять trusted activity revision после successful correction

**Citation:** [src/application/assistant-service.ts:591–595](../../src/application/assistant-service.ts#L591-L595), [work-retrospective-request.ts:75–83](../../src/application/work-retrospective-request.ts#L75-L83). Consumer target check: [activity-transaction-service.ts:305–313](../../src/application/activity-transaction-service.ts#L305-L313).

`bindFacts` обрабатывает collect outcomes, включая nested linked, но не completed correction. Request добавляет refs лишь по отсутствующему activityId; обновления revision существующего ref нет. Успешное уточнение повышает canonical activity revision, а эпизод и следующий вопрос продолжают передавать extractor старую revision. Safety check корректно отвергает эту stale mutation; ошибка — потеря актуальной связи producer, не необходимость ослабить check.

- **Given:** canonical collect одной работы с duration и ref revision 1; вопрос про способ выполнения; fake clock +1s между turns, окно <72h.
- **When:** первый short answer делает linked correct до revision 2; close+следующий вопрос того же эпизода; следующий short answer вновь делает bound correction с revision из доверенного snapshot. Stub extractor не угадывает target и не выбирает произвольную revision.
- **Actual:** первая activity revision=2, episode ref=1, следующее correction outcome `failed/persistence_conflict`. Даже `episode_updated` со statement не обновляет ref.
- **Expected:** после первого successful correction metadata хранит ref=2; после restart следующий bound correction работает и даёт revision 3, без второго activity/time. Failed/unknown outcomes ref не двигают; внешние stale/foreign targets по-прежнему отвергаются.
- **Направление fix:** передавать successful handle/revision в request-staged durable metadata через typed closure; не менять 72h, не ребиндить произвольные stale targets и не переносить report approval.

Безопасный outcome:

```json
{"probe":"continuity","actualActivityRevision":2,"episodeActivityRevision":1,"thirdCorrection":"failed","code":"persistence_conflict"}
```

## F3 — валидировать activity dependencies при message-only provenance

**Citation:** [src/application/retrospective-recommendations.ts:238–242](../../src/application/retrospective-recommendations.ts#L238-L242), client grouping [company-reporting.ts:283–289](../../src/application/company-reporting.ts#L283-L289), real producer [work-retrospective-request.ts:78–80](../../src/application/work-retrospective-request.ts#L78-L80).

`statement.sourceRefs` реального request producer содержит только current message. `supported` валидирует activity revision/status лишь для activity-type statement refs; `episode.activityRefs` не проверяется. Client projection связывает routine с episode activity по subject/id, без revision. Поэтому standalone canonical correction не меняет поддержку кандидата. Наличие episode revision checks не компенсирует отсутствующую activity invalidation.

Existing publish fixture добавляет к statement ещё activity sourceRef вручную; composition fixture после correction отдельно обновляет episode. Оба пути дают зелёный тест, но не покрывают фактический message-only producer + activity-only mutation.

- **Given:** checked candidate с operator review, два contributors, шесть aggregate observations; extractive statements имеют только message refs, episodes имеют activity refs revision 1. Preflight findings соответствуют client DTO.
- **When:** activity revision повышается до 2 без изменения grouping/episode/message; повторные build и publish с прежними findings и explicit operator decision.
- **Actual:** checked recommendation остаётся; client hash не меняется; publish `ok:true`. Отдельная probe typed `ActivityCorrectionService` подтверждает, что validator сохраняет checked при dependency revision 2 → actual revision 3.
- **Expected:** stale dependency лишает candidate checked eligibility до recompute/check, client recommendation исключается, прежний findings hash не позволяет publish. Supersession/missing/purge также инвалидируют, даже без episode write.
- **Направление fix:** проверять scoped revision/status activity dependencies цитируемых episodes в общем support/read/check/save/publish пути. Не требовать ручной activity sourceRef или дополнительного episode update; 0 LLM на build/publish и confidence policy сохраняются.

Безопасные outcomes:

```json
{"probe":"recommendation-invalidation","activityRevision":3,"dependencyRevision":2,"checkedAfterCorrection":1}
{"probe":"publish-after-correction","activityRevision":2,"dependencyRevision":1,"recommendations":1,"oldFindingsStillMatch":true,"publishOk":true}
```

Полные воспроизводимые fixtures, минимальные актуальные excerpts и Given/When/Then находятся в `br show mnt-hf3h.27`, `.28`, `.29`. Probe запускалась временными файлами вне репозитория через `node --import tsx`; production services не вызывались. Этот receipt сохраняет безопасные результаты, не зависит от доступности `/tmp` и не сохраняет synthetic credential literals/raw corpus.

## Покрытие review и ограничения

| Граница | Проверенный путь / вывод |
|---|---|
| Owner/company/group/thread | Trusted request closure, exact scoped canonical/event reads, participant discovery, PostgreSQL owner predicates, чужие/stale targets и group-off fixtures. Подтверждённой cross-tenant находки нет; это не proof of absence |
| Typed writes / external actions | Tools не выбирают identity/target и stage events до canonical ответа; factual collect/correct используют existing typed use-cases; external proposal/confirmation path не заменён |
| Secrets / sanitized corpus | Metadata/projection/export/generator sanitization просмотрены; F1 — конкретный пробел. Existing sanitizer не расширяется в общий аудит adversarial inputs |
| Durability/replay/outcomes | Canonical turn+events, separate delivered receipts, bounded ledger, disposable rebuild, linked transaction reservation и partial/unknown outcomes; F2 — continuity refs после correction |
| Purge/sanitize/recompute | Subject/group/company lifecycle, immutable artifact owner/history и MinIO versions, canonical FK deletion, contributor dependency. F3 — invalidation без episode mutation |
| Evidence → report | Extractive factual evidence, operator checked artifacts, latest durable version, deterministic v3, confidence/grouping и private-field stripping, preflight hash/operator publish; F3 подтверждён до fake publish |
| Daily → weekly → final | Directory period/IANA, 4/8 delivered budgets, consent из employee origin, touch provenance/dedup/replacement, summaries за group period и historical reads; existing offline fixtures зелёные |
| Методика / evaluation / запуск | Vault четыре этапа, запрет coercion/guessed facts, self-report/unknown distinction, evaluation omissions и runbook private permissions сверены; live полезность и двухнедельный эффект **не проверены** |

Multi-instance coordination, Unicode smuggling, prompt injection через собственные данные, дополнительный fail-closed/allow-list и чисто стилистический cleanup **не блокируют** этот раунд по pilot quality bar. Отдельных P3/P4 задач по предпочтениям ревьюера не создаётся. Отсутствие таких задач не означает отдельный исчерпывающий cleanup-аудит.

## Фактические проверки

На exact review HEAD, без изменения runtime:

```bash
npx vitest run specs/executable/minutka/SPEC-RETRO*.spec.ts \
  specs/executable/minutka/SPEC-MINUTKA-ACTIVITY-TRANSACTION-EXTRACTOR-001.spec.ts \
  specs/executable/telegram/SPEC-FEEDBACK-001.spec.ts --exclude='.direnv/**'
npx vitest run specs/executable --exclude='.direnv/**'
git diff --check
br lint mnt-hf3h.14 mnt-hf3h.27 mnt-hf3h.28 mnt-hf3h.29
```

- Focused: **21 files / 164 tests passed**.
- Полная offline regression: **140 files / 1277 tests passed**. Сообщения о required CLI options — ожидаемые negative command fixtures, итог exit 0.
- Synthetic probes: три findings воспроизведены; assertions и safe outcomes выше. Не новый постоянный runtime harness и не исправление дефектов.
- Docs diff/link checks и `br lint`: **pass** после оформления receipt/findings.
- TS/JS в этой задаче не изменяется; typecheck/build и `npm run verify` не запускаются. Для будущих changed TS/JS в pi требуется **LSP diagnostics**, не compiler command.
- Persistence/MinIO smoke заново **не запускались**; прошлый isolated TEST pass `.26` — только provenance [runbook receipt](../runbooks/work-retrospective-cycle.md#готовность-и-разрешения), не результат этого review и не green integration gate.
- Реальные Telegram send, production reads/migrations, LLM generation, deployment и client delivery **не выполняются**. Все publish probes используют in-memory fake transport/audit, не публикуют артефакт компании.

## Acceptance receipt

| ID | Given / input | Фактический outcome | Безопасный артефакт |
|---|---|---|---|
| SPEC-RETRO-REVIEW-01 | Полный exact base..HEAD, producers + composition + runbook | Один review: request changes, F1–F3 с citations, воспроизведением и evidence; 164 focused / 1277 regression pass не маскируют blockers | Этот receipt: диапазон, findings, coverage, safe probe outcomes |
| SPEC-RETRO-REVIEW-02 | F1 secret line, F2 pilot flow, F3 invalidation/report | Созданы дочерние P1 `.27/.28/.29` с R-ID misfit и acceptance fixtures; все три блокируют `.15` | `br show mnt-hf3h.27/.28/.29` и `br show mnt-hf3h.15` |
| SPEC-RETRO-REVIEW-03 | Общая обвязка/style и out-of-scope quality bar | Не блокируют gate, задач wish-list не заведено; второй review не открыт | Раздел покрытия/ограничений; graph содержит только подтверждённые finding fixes |

Следующий шаг: `.27/.28/.29` отдельными atomic issue commits → `.15` integration gate/regression/разрешённый Telegram smoke. Нет разрешения на живой scope — smoke/live отмечается blocked, не pass. Фиксы не подтверждают semantic качество методики: его оценивают только разрешённый полный двухнедельный цикл `.16` и итоговый анализ.
