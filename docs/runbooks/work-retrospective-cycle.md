# Полный цикл ретроспективы рабочего эпизода

Операционный путь по [принятому RFC](../architecture/rfc-routine-ontology-and-targeted-clarification.md): факты → **Действия → Ценность → Будущее → Индикаторы** → недельный возврат → личный итог → проверенная рекомендация компании → анализ двух недель. Это внедрение методики, не отдельный режим и не анкета классификации.

## Готовность и разрешения

Producers `mnt-hf3h.20`–`.26` закрыты. Receipt `.26`, completion commit `0f93c73a57d649681a787885af70fced7cd82d06`: 104 retrospective specs, 63 persistence specs и 1277 executable specs прошли; мигратор подтвердил `0081`–`0084` и отсутствие pending на отдельной TEST-БД. Composition проверяет настоящий service/scheduler/Telegram shell с fake внешней доставкой и моделью, а не ручную регистрацию или seeded checked artifacts. Это **не** live Telegram smoke, не единственный review `.14`, не integration gate `.15` и не доказательство двухнедельного эффекта.

**Live deployment blocked:** здесь нет private launch manifest и операционного разрешения. Нельзя выбирать другую компанию/группу, применять production-миграции, менять период/расписания, отправлять сообщения или публиковать отчёт по этому документу. Согласование методики для текущей группы не заменяет этих разрешений. Следующие шаги — `.14` и `.15`; живой цикл `.16` требует green gate и manifest оператора.

Manifest хранится вне Git с доступом только доверенной команде:

- точные company/group, существующие inclusive start/end полного двухнедельного `training_groups.period`, приглашённые участники и состояние onboarding/consent;
- IANA timezone каждого профиля, owner-scoped enabled/time/days утреннего, вечернего и недельного расписаний, время разового final;
- deployment commit, method/process, prompt/model и generator versions, версия справочника (если используется), активная privacy version;
- разрешения на deployment/migrations, scope реальных касаний и отдельное решение на публикацию, ответственный оператор, расположение private receipts/snapshot.

Не помещать в Git manifest, цитаты, реальные IDs, subject keys, traces, decisions или credentials. Приватные output-файлы — вне репозитория, `umask 077`, доступ `0600`; shell stdout отчётных команд тоже приватный.

## 1. Подготовка среды, периода и версий

1. Сверить manifest со [справочниками тенантов](tenant-reference-directories.md), профилями и существующими расписаниями. Не менять даты ради успешной проверки. `TenantDirectoryStore.getGroupPeriod` возвращает обе локальные даты включительно; приложение строит ISO `[start, midnight после end)` в IANA timezone, с DST, не как UTC-дни.
2. Проверить активный `work_retrospective` в [registry](../../vault/assistant/processes/registry.json) и штатный runtime. Доступность связывается приложением с авторизованным tenant, каталогом, периодом и версией `work-retrospective-v1`. Отдельного durable enabled state группы нет. Персональные enabled/time scheduled-процессов сохраняются; `work_retrospective` chat-only, не новый schedule и не третий daily push.
3. Сверить версии: `retrospective-recommendations/v1`, generator `retrospective-recommendation-generator/v1`, client `minutka-client-report.v3`, internal `minutka-internal-report/v2`; конкретные prompt/model/process revisions зафиксировать в manifest, не считать их неизменными по имени схемы.
4. Миграции `0081`–`0084` — deployment durable данных, не prerequisite нового policy CLI. Миграции `0085` policy нет. **Только по отдельному deployment-разрешению** выполнить штатный `npm run db:migrate` в утверждённой среде по [PostgreSQL runbook](postgres-runtime.md); в этой docs-задаче production команда не выполняется.
5. До приглашений сверить canonical consent по [процессу privacy](../../vault/assistant/processes/consent_and_privacy.md). Onboarding остаётся четырьмя вопросами, не questionnaire о рутинах. Объяснить прямую пользу сотруднику, добровольность разбора и право остановиться. Доверенная исследовательская команда читает полный scoped corpus/traces для analysis, prompt/taxonomy improvement и evaluation; компания получает только проверенный client artifact. Model training исключён. Не менять privacy version/re-consent неявно.

## 2. Первая неделя: факты и daily episodes

Утро — план и первый шаг; день — добровольное перепланирование; вечер — все явно названные начатые/выполненные работы и предложение разобрать один случай. План, индикатор и гипотеза не activity. Длительность, label/id и согласие на разбор не являются условием factual write. Справочник вспомогательный: отсутствие label само по себе не повод допрашивать.

В [work_retrospective](../../vault/assistant/processes/work_retrospective.md) уже названное не переспрашивается, неизвестное остаётся неизвестным. Daily ориентир 3–5 минут, максимум четыре дополнительных **доставленных** вопроса за локальный день, включая служебные уточнения/приглашение; один смысловой вопрос за ход. При отказе, усталости, лимите или паузе — итог известных фактов/пробелов без давления. Добровольные факты принимаются и после лимита.

Проверять canonical question/response refs, pending target revision и фактический Telegram outcome. Генерация не доставка: failed delivery не расходует бюджет и не означает отказ. Restart не сбрасывает бюджет. Короткий ответ должен уточнять связанный случай; составной ответ обрабатывается через typed correction + collect без повторного времени. Неоднозначные/stale/чужие refs не дают mutation; factual сохранение не откатывается из-за ошибки проекции.

На checkpoint первой недели фиксировать delivery/response с явными знаменателями, ошибки/пропуски и затраты оператора. Сигналы пересмотра [RFC ритма](../architecture/rfc-minutka-daily-rhythm.md) сохраняются: delivery <95% — разбор доставки, response <50% либо жалобы/отключения двух сотрудников — решение оператора о ритме, не автоматическая смена расписания и не вердикт об эффекте методики.

## 3. Weekly и вторая неделя

`readWeeklyActivities` даёт личные weekly facts и read-only retrospective за **весь период группы**. К выбранному шагу/индикатору возвращаться только с `followUpConsent`: что действительно попробовали, что заметили, что осталось намерением. Сам выбор шага не попытка, попытка не успешный результат.

Для углублённого сеанса нужно свежее явное сообщение сотрудника: `weeklyConsent:true` — поле typed update, не отдельный tool. Scheduled приглашение, неоднозначное «да» или follow-up consent не открывают сеанс. Weekly ориентир 10–15 минут, максимум восемь дополнительных доставленных вопросов **вместо**, не поверх daily бюджета: на этот локальный день, один сеанс за календарную неделю; на следующий день снова daily четыре, на следующую неделю новое согласие.

Успешно доставленное weekly/final касание заменяет evening invitation того же локального дня. Отключённое, недоставленное или ещё не доставленное касание не подавляет вечер; canonical receipt, а не генерация, управляет замещением. Уже открытый разбор не вытесняется. Два daily schedule остаются; настройки owner соблюдаются.

В week2 собирать реальные попытки/наблюдавшиеся индикаторы и новые случаи без требования ежедневно находить проблему. Неделя читает старые эпизоды, но не расширяет **72h factual correction window**: старый результат обсуждается без мутации старой activity; correction за пределами окна — штатная операторская процедура.

## 4. Личный final и feedback

После фактически завершённых двух недель сверить период и выполнить **сначала preview**, по [end-of-cycle](end-of-cycle.md):

```bash
npm run cycle:final-reports -- --company <c> --group <g> --preview
```

Это шаблон, `<c>/<g>` берутся только из manifest. Preview не ставит расписания. Реальная постановка без `--preview` требует отдельного разрешения и точной строки `SEND FINAL REPORT <c>/<g>`; команда ставит one-shot, дальше отправляет штатный scheduler. `--at HH:MM` — локальное время каждого сотрудника. Не подтверждать команду моделью.

`readCycleActivities` использует inclusive период группы; после его конца историческая read-only retrospective остаётся доступна, новые invitations/pending прекращаются. Дата позднего запуска не теряет начало и не добавляет after-period activities. Личный итог различает факты, интерпретации, намерения, попытки, результаты и гипотезы; не требует 2–3 шагов без evidence, не выдаёт каталог quick wins. Он **не** client report. Компания не получает личный текст, но исследовательская команда сохраняет разрешённый scoped доступ к каноническому разговору.

Собрать добровольный feedback о прямой пользе, навязчивости и самооценке времени; сохранять источники и число ответивших. Не считать silence нулевой нагрузкой/успехом. Existing message feedback использовать отдельно; недоступный финальный feedback отметить missing.

## 5. Подготовка и проверка рекомендаций

Все команды ниже — **операторские шаблоны, не разрешение на production исполнение**. Используют существующий `company-report`, typed scoped research reads и durable immutable artifacts, не новый CLI. Prepare/recompute используют модель; check — явное решение оператора, не LLM-экспертиза.

```bash
npm run company-report -- prepare-recommendations --company <c> --group <g>
npm run company-report -- check-recommendations --company <c> --group <g> \
  --artifact <id> --decisions /private/operator/decisions.json
npm run company-report -- recompute-recommendations --company <c> --group <g> --artifact <id>
```

Prepare сохраняет draft/rejected кандидатов. Проверить **JSON outcome**, не только exit code: успешный результат — `status: applied`, `artifactId`, `version`; failed/not_found/forbidden/stale — остановка пути, не checked. Команда может вернуть failed JSON с нулевым exit. Private artifact читать только существующим typed recommendation read в разрешённом research-контексте, не угадывать object key/SQL и не изобретать export-команду.

Формат private decisions (все значения — placeholders):

```json
{"operatorId":"<operator>","decisions":{"<candidate-id>":"checked","<other-candidate-id>":"rejected"}}
```

Оператор сверяет каждого кандидата с разрешённым evidence: операция/возможность, вход/выход/способ/критерий, unknowns, первый выполнимый тест, ожидаемый признак, human control и stop condition. Нет опоры — rejected/deep_dive, не generic обещание. Не указанный в decisions кандидат остаётся draft. Check создаёт **новый** immutable artifact ID/version; сохранить lineage и использовать новый ID для следующих операций. Recompute снова генерирует draft, предыдущий checked не переносится. Durable latest читается штатным report path после restart; ошибка чтения не означает fallback к старому одобрению.

Correction/supersession/purge инвалидируют зависимые выводы. Следовать [purge](research-scope-purge.md), [персональному удалению](employee-personal-data-deletion.md), sanitize/recompute и очистке private копий/справочника; facts вне exact scope не удалять. Затем recompute → operator check → новый build/preflight/publish. Старое approval нельзя переносить на изменённое evidence.

## 6. Детерминированный report, preflight и publish

Справочник — вспомогательный артефакт проверенных имён/группировки, не доказательство рекомендации. Если используется, валидировать его по [report export runbook](company-report-export.md). Без подходящей клиентской рутины рекомендации не называются: текущая projection требует разрешённое имя, минимум три observations и два contributors с совпадающими episode/activity refs; confidence policy не понижается. Уточнения одного эпизода не независимые случаи, часы учитываются один раз.

Штатный путь по активному каталогу/периоду выдаёт **v3** даже без checked кандидатов: recommendations пусты/deep_dive, generic quick wins и firstSteps удалены. v2 directory-only путь — исторический/без retrospective eligibility, не fallback для этой группы. `--recorded-before` **несовместим** с текущими recommendation reads (`recommendations_snapshot_incompatible`): не копировать v2 frozen-cutoff примеры в этот цикл. Воспроизводимость обеспечивают сохранённые private inputs/версии/артефакты, не смешение current episodes с historical activities.

```bash
npm run company-report -- build --company <c> --group <g> \
  --directory /private/operator/directory.json --out /private/operator/report.draft.json
# Отдельный явный LLM-шаг; build/publish используют 0 LLM.
npm run company-report -- preflight-llm --company <c> --group <g> \
  --directory /private/operator/directory.json --out /private/operator/findings.json
npm run company-report -- resolve-finding --company <c> --group <g> \
  --directory /private/operator/directory.json --finding <finding-id> --decision verified \
  --findings /private/operator/findings.json
# Только после отдельного решения оператора о передаче:
npm run company-report -- publish --company <c> --group <g> \
  --directory /private/operator/directory.json --findings /private/operator/findings.json \
  --operator-publish --out /private/operator/client-report.json
```

Для исправленного finding — `--decision fixed`. Preflight проверяет и recommendation texts. Findings envelope должен иметь текущие scope/hash client DTO; missing/stale findings, unresolved high и отсутствие `--operator-publish` блокируют v3 publish. После любого изменения evidence/версии снова build/preflight/решения. Проверять `ok:true` и итоговую схему/границу, не просто существование старого output-файла. Resolve и publish stdout могут содержать private report/result: не логировать публично.

Компании передаётся **только** успешный client artifact: без corpus, quotes, source refs, traces, subject keys, operator identity, личных обещаний/эмоциональных оценок. Не передавать internal DTO, recommendation artifact или findings. Публикация не доказывает ROI/API-доступ/реализуемость интеграции; неизвестное и ограничения остаются. Уже переданный документ не отзывается автоматически.

## Integration gate `.15`: dev receipt и остающийся smoke

[Gate receipt](../researches/work-retrospective-gate.md): final source tree на baseline `492bb80` + atomic `.15` changes — 1300 executable / 127 retrospective / 8 E2E / 63 isolated PostgreSQL tests passed, LSP clean. Local dev migrations 0081–0084 применены, pending=[]; production не затронут. Старый composition E2E перенесён в `SPEC-RETRO-E2E.spec.ts`.

**Итог: `.15` закрыта по решению оператора.** На HEAD `ace8dcd64a7cdfd1608cff10f6db0d7a2ca0b3e5` dev API и HTTP CLI business gate PASS: одна activity, corrections revision 1→2→3 с изменением duration bucket и restart, canonical refs актуальны. Initial 503 и stale-ref bugs исправлены. Privacy config настроен оператором. Telegram smoke исключён из acceptance `.15`, **не выполнялся**, остаётся предпусковой проверкой `.16`; это не Telegram PASS. Пример HTTP CLI:

```bash
# Private dev env, employee-scoped MINUTKA_API_TOKEN; не service/admin token.
npm run cli -- employee profile
npm run cli -- employee chat --thread <test-thread> --text 'Подготовил отчёт за полчаса'
```

HTTP CLI profile/chat, bound corrections, restart и refusal проверены на разрешённом dev employee. Повторять полный business scenario через Telegram не требуется. Перед живым `.16` проверить только Telegram transport: разрешённая chat/employee/thread binding, actual send и durable delivery receipt, delivered budget и proactive routing. Для запуска `.16` отдельно нужны private launch manifest и operational permission; закрытие `.15` их не заменяет. Полные результаты и ограничения — в receipt.

## 7. Остановка, журнал и полный анализ

При утечке, потере фактов, дублях времени немедленно приостановить проблемный путь и сообщить оператору. Новые приглашения ограничены existing process availability/end period; scheduled touches управляются существующими owner-managed schedules. Нет универсального dynamic chat switch; не выдумывать group enable/disable или менять каталог/период для обхода проблемы. При завершении периода pending закрывается, факты и исторические summaries сохраняются. Не продлевать цикл/не менять cadence без оператора.

В private журнале: **date → reason → old/new version**, checkpoint (включая day5), изменённые формулировки/модель/часы, delivery failures, исправления, затраты оператора и ссылки на evidence. Косметическая корректировка не сокращает две недели; существенная смена методики раскрывается как отклонение, не склеивается в неизменный режим.

После полного периода сохранить private snapshot: typed corpus export, messages/activities/revisions, full traces/feedback, canonical delivery/session/episode metadata, recommendations с lineage/reviews, versions, manifest и журнал. Хранить по существующему retention/purge scope, не создавать вечный независимый архив.

Выполнить [retrospective evaluation](retrospective-evaluation.md). Явно разделить локальный календарь расписаний/бюджетов и UTC seven-day bins/participant-days evaluator. Анализ охватывает delivery/eligible и response/delivered, принятые приглашения, started/completed/paused episodes, evidence-backed четыре этапа, selected step/attempt/observed result, пропуски/ошибки/дубли/short answers, feedback burden/usefulness, complaints/disable, качество и причины отклонения рекомендаций, usage/latency/failures и операторские минуты.

Offline CLI без LLM даёт structural checks и отмечает semantic rubric/paired comparison unavailable. Для полной рубрики нужен разрешённый versioned generator application evaluation и проверка оператором всех итоговых кандидатов/спорных случаев; fixture не заменяет live evidence. На одних случаях сравнить factual-only и full-episode первый тест с новыми опорами; это диагностика evidence, не причинный A/B. Недоступное отмечать omissions, не нулями.

Решение оператора после анализа: развивать / изменить и повторить полный цикл / не продолжать. Недостаток feedback или week2 evidence означает «эффект не подтверждён», не компенсируется числом activities. Smoke и TEST pass не являются полным циклом; эпик здесь не закрывается.

## Проверка документа и receipt `mnt-hf3h.13`

| ID | Given / проверка | Outcome |
|---|---|---|
| SPEC-RETRO-RUNBOOK-01 | Closed `.20`–`.26`, сверка команд с runtime/fixtures | Каталог, period/IANA, canonical delivery, owner schedules, prepare/check/recompute, deterministic v3 и отдельное deployment-разрешение описаны; никаких policy/help prerequisites |
| SPEC-RETRO-RUNBOOK-02 | Полный двухнедельный путь, §§2–7 | Week1/week2/checkpoints/final/feedback, private snapshot, date-reason-version и full analysis покрыты; техническая проверка не заявлена live эффектом |
| SPEC-RETRO-RUNBOOK-03 | Related RFC/runbooks/skills/onboarding, relative links и diff check | Historical generic путь отделён от current evidence-backed; privacy/confidence/72h/factual independence сохраняются |
| SPEC-RETRO-RUNBOOK-04 | Нет manifest/operational permission | Live deployment явно blocked, scope не выбран; production migrations/send/publish не выполняются |

Фактическая focused verification `mnt-hf3h.13` на baseline `0f93c73`:

- `npx vitest run specs/executable/minutka/SPEC-RETRO*.spec.ts specs/executable/minutka/SPEC-MINUTKA-FINAL-REPORT-001.spec.ts --exclude='.direnv/**'` — **116/116**, 20 files; command fixtures покрывают prepare/check/recompute и final preview без send.
- `loadDotEnv` + parsed host/port/database guard: обе TEST роли в одной explicitly test-named базе, отличной от обеих production identities; `SELECT 1` обеими ролями — **pass**, URLs не раскрывались.
- На этой migrated TEST-БД: `company-report --help` и help `prepare-recommendations`/`check-recommendations`/`recompute-recommendations` — **exit 0**, параметры сверены. `cycle:final-reports --company company_runbook_test --group group_runbook_test --preview` — **exit 0**, synthetic empty scope, eligible/notOnboarded 0, без arming/send.
- `git diff --check` — **pass**; scripted relative Markdown link check — **93 targets / 8 изменённых Markdown files, pass**; `br lint mnt-hf3h.13` — **без warnings**.

Persistence 63/63 и миграции 0081–0084 — receipt dependency `.26`, не повторный destructive run этой docs-задачи. Новые runtime harness, typecheck/build, production reads/migrations/send/publish не выполнялись. Readiness outcome остаётся **blocked live deployment**, не blocked документный срез; `.14`/`.15` и manifest/permissions ещё нужны. При повторе TEST help/preview заново подтвердить identities; недоступная проверка — blocked, не pass.

Для безопасной проверки среды загрузить `.env` через `loadDotEnv`, **не печатать URLs**. Parsed host/port/database обеих TEST ролей должны совпадать, имя базы содержит `test`, identity отличается от обеих production URLs; затем `SELECT 1` обеими TEST ролями. Persistence destructive: только эта отдельная TEST-БД, по guard/receipt `.26`, никогда `npm run db:migrate` с production env. После guard можно выполнить `npm run specs:persistence` с TEST URLs и без production DATABASE_URL/MIGRATION_DATABASE_URL.

Help проверять через `loadDotEnv` + child process с явными `DATABASE_URL=TEST_DATABASE_URL`, `MIGRATION_DATABASE_URL=TEST_MIGRATION_DATABASE_URL` overrides: `npm run company-report -- --help` и help трёх recommendation subcommands; `npm run cycle:final-reports -- --company <synthetic-test-company> --group <synthetic-test-group> --preview`. Не использовать private launch scope. `company-report` требует migrated TEST storage даже для help; отсутствие production readiness — не повод исполнять migration. Purge command preview подтверждён persistence fixture `.26`; полный purge CLI не заявлен no-write: bootstrap готовит MinIO bucket. Никаких реальных sends/publish в smoke.
