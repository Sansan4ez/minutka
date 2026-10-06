# Integration gate ретроспективы — `mnt-hf3h.15`

## Outcome и проверенная ревизия

**Offline / isolated PostgreSQL / dev CLI activity gate: PASS. Причины initial 503 и stale refs исправлены и проверены. Telegram transport delivery: NOT RUN (не prerequisite проверки сохранения activities через общий runtime). **`.15` CLOSED по явному решению оператора:** Telegram smoke исключён из acceptance этого gate и перенесён в предпусковую проверку `.16`. Это waiver, не Telegram PASS. `.16` не запускать автоматически.

Закрытие подтверждает проверенный source HEAD `ace8dcd64a7cdfd1608cff10f6db0d7a2ca0b3e5`: 1300 executable / 8 E2E / 63 isolated persistence passed, changed TS LSP clean. Ниже initial BLOCKED результаты — хронологические записи, superseded итогом CLI business gate; Telegram фактически NOT RUN.**

Проверенная база: `492bb80c4a5063e797d84d156aba578c612a60ff`, плюс изменения атомарного коммита `mnt-hf3h.15`, содержащего этот receipt. Точный implementation HEAD после commit: `git log -1 --format=%H -- specs/executable/minutka/SPEC-RETRO-E2E.spec.ts`. Не выдаём результаты baseline за проверку неизменённого final HEAD: проверки выполнены на final source tree перед commit, далее меняются только docs/beads.

Единственный review: [receipt `.14`](work-retrospective-review.md). `.27/.28/.29` CLOSED; нового review не было. Production scope не читался и не изменялся; live manifest не выбирался. Проверки выполнялись на dev host в `/home/admin/minutka`.

## Изменения и проверяемая цепочка

Существующий `SPEC-RETRO-COMPOSITION-E2E.spec.ts` перенесён в требуемый `specs/executable/minutka/SPEC-RETRO-E2E.spec.ts`, не дублирован. Настоящие AssistantService, typed collection/correction, canonical metadata, disposable projection, scheduler, Telegram shell, recommendations и operator publish; fake clock, stub model и transport, без LLM/сети.

- Факт → short answer → четыре этапа с типами/provenance → выбранный шаг и indicator → отдельное follow-up consent → week2 наблюдение → final scheduled summary → aggregate evidence → prepare/check CLI → восстановленный checked artifact → deterministic client → operator publish.
- Во второй неделе план/indicator/наблюдение не создают дополнительной activity или часов. Weekly 8 delivered questions, restart и замещение evening сохраняются.
- После **activity-only** correction episodes остаются неизменными; message-only statement provenance не препятствует invalidation, recommendation исчезает, старые findings блокируют publish.
- CLI parser + employee SDK + in-process transport: short answer, restart каждого turn, отказ без потери факта, off-control без retrospective metadata.
- Выявлен и исправлен конкретный integration misfit: employee in-process transport возвращал application-only поля; strict SDK DTO отвергал chat response. Теперь projection совпадает с service/HTTP DTO; CLI regression использует настоящий EmployeeMinutkaClient.
- Failed Telegram send не становится delivered и не расходует budget при восстановлении projection.

## Фактические проверки

| Команда / проверка | Результат |
|---|---|
| `npx vitest run specs/executable/minutka/SPEC-RETRO-E2E.spec.ts` | 1 file / **8 passed** |
| `npx vitest run specs/executable/minutka/SPEC-RETRO*.spec.ts` | 19 files / **127 passed** |
| `npm run specs` | 140 files / **1300 passed** |
| LSP diagnostics: E2E file и `src/server/http/in-process-transport.ts` | **No diagnostics** |
| TEST guard: обе роли одной test-named БД, identity отличается от обеих dev URLs; обеими `SELECT 1` | **PASS**, URLs не выводились |
| `npm run specs:persistence` после guard, без DATABASE_URL/MIGRATION_DATABASE_URL в child env | 1 file / **63 passed**, включая migration parity 0081–0084, metadata/revisions/purge/operator preview |
| `npm run db:migrate` только local dev, parsed loopback `/minutka` guard обеих URLs | **PASS**: применены 0081–0084, pending=[] |
| `TELEGRAM_MODE=disabled TELEGRAM_INVITES='' npm run serve` | **BLOCKED**: отсутствует обязательный `PRIVACY_POLICY_V6_URL`; API listener не запущен |
| Live HTTP employee CLI / Telegram | **BLOCKED**, не выполнялись; in-process fixture не выдаётся за live smoke |

Persistence выдаёт existing pg deprecation warning про concurrent query на client, exit 0. Typecheck/build/verify не запускались. TEST suite destructive только в isolated TEST; локальные dev-миграции отдельно разрешены запросом на dev-сервер. Внешние sends, production migrations и company delivery не выполнялись. Private logs в `/tmp/minutka-15-*.log`, не в Git; они временные, этот receipt достаточен для безопасного итога.

## Acceptance receipt

| ID | Given / input | Outcome |
|---|---|---|
| SPEC-RETRO-E2E-01 | Full composed cycle, CLI off control | **PASS offline**: факты/этапы/step/indicator/follow-up/recommendation связаны, operator publish детерминирован; off без retrospective writes |
| SPEC-RETRO-E2E-02 | Bound success/stale/foreign/unknown через restart; linked transaction suite: replay m2, partial stale+collect, outcome unknown | **PASS offline**: refs advance только при confirmed correction; нет repeat time/слепого retry, partial outcomes раздельные |
| SPEC-RETRO-E2E-03 | Isolated PostgreSQL и CLI fixtures; реальный dev runtime | PostgreSQL **PASS**, CLI fixture **PASS**; live delivery/refusal/short-answer durable **BLOCKED** до deployment config и разрешённого test owner |
| SPEC-RETRO-E2E-04 | Runtime prerequisite отсутствует / fake transport fails | **PASS честного ограничения**: отсутствие privacy URL блокирует запуск, live gate не green; send failure не считается доставкой |

F1 sanitizer regression: `SPEC-RETRO-METADATA` и canonical metadata/context/export fixtures. F2: E2E continuity success до revision 3 после restart, stale/foreign/unknown не двигают ref. F3: message-only provenance, unchanged episode после standalone correction, stale findings. Refusal, partial/replay, purge/recompute, 6000 context и 4/8 budgets дополнительно покрываются полной retrospective regression; это не новое ревью.

## Дополнение: разрешённый dev CLI smoke

Оператор предоставил privacy URL, разрешил обоих test employees и изменение периода их dev test group. Использован `emp_pilotrun_one`; employee token подставлялся только в child env, без изменения credentials в `.env`. Период группы изменён с 01–31.08 на **07–20.10.2026** (14 дней от локальной даты сотрудника; shared test group, не production). Это не launch `.16`.

- Dev API startup и `npm run cli -- employee profile`: exit 0.
- Первый factual HTTP turn в `retro-gate-dev-smoke`: exit 0, одна canonical activity `15_30m`, revision 1. При старом completed period retrospective корректно не открылся.
- После обновления периода два HTTP turns нового `retro-gate-dev-active` вернули 503 с uncertain-outcome response. До следующего действия проверены canonical messages и activities: сообщений нового thread нет, новых factual записей нет. Слепой retry factual рассказа не выполнялся. Причина этих двух сбоев **не установлена**; успешные последующие вызовы их не маскируют.
- Direct штатный Postgres runtime с настоящей моделью сохранил episode/value/question через тот же AssistantService; это diagnostic application call, не HTTP pass.
- Контролируемый restart dev API, затем HTTP CLI «Сверил цифры.»: exit 0, модель продолжила сохранённый episode и задала вопрос этапа future. Refusal «Не хочу продолжать разбор. Остановимся.»: exit 0, episode `declined`, pending отсутствует.
- Итог PostgreSQL: три canonical turns active thread, одна сегодняшняя factual activity сотрудника; CLI delivery budget **0**, как ожидается без Telegram receipt. Старые fixtures activities не удалялись, consent не принимался вместо сотрудника.
- Dev API оставлен запущенным с `TELEGRAM_MODE=disabled`; стартовые scheduled попытки без Telegram transport завершались failure, реальных sends не было.

Live full factual→bound correction цепочка пока не подтверждена HTTP: active episode открыт после уточнения и не содержит bound activity ref предыдущего thread. Не утверждаем no-double-time bound correction pass по этому live smoke; эта гарантия подтверждена offline E2E. Для завершения gate нужен свежий связанный factual эпизод и реальный Telegram smoke. Temporary private operational receipts/logs: `/tmp/minutka-15-dev-period.json`, `/tmp/minutka-15-cli-*.log`.

## Итог CLI business gate после live исправлений

По запросу оператора завершён shared-runtime сценарий без Telegram. Выявлены два конкретных integration misfit:

1. Reservation `linked_activity_transactions` ссылалась на thread, который ещё не существовал на первом factual turn. FK insert failure попадал в conservative `outcome_unknown`, давал HTTP 503 до extractor и до сохранения фактов. PostgreSQL adapter теперь атомарно создаёт thread + reservation. Persistence fixture изменён: claim вызывается **до** canonical append. Никакие миграции/ослабления FK не нужны.
2. При подтверждённой correction model могла не вызвать retrospective update. Тогда activity переходила на revision 2, а canonical episode ref оставался revision 1; следующая correction отклонялась. `bindCorrectedActivity` теперь staging canonical episode update и provenance независимо от model call. E2E success case намеренно пропускает update на correction turn, затем проверяет следующую correction после restart.

Fresh HTTP CLI thread `retro-gate-dev-final`, реальная модель и PostgreSQL:

| Шаг | Результат |
|---|---|
| Рассказ о проверке бюджета проекта Запад за 20 минут | exit 0, один факт revision 1, bucket `15_30m`, bound episode |
| Уточнение той же работы на 45 минут | exit 0, тот же activity ID revision 2, bucket `30_60m`, canonical ref revision 2; model не вызывала retrospective update |
| Контролируемый restart dev API, уточнение на 70 минут | exit 0, тот же activity ID revision 3, bucket `1_2h`, canonical ref revision 3 |

Итог: **ровно одна activity**, время заменено, не суммировано, сохранение и correction не зависят от Telegram. Successful corrections возвращают `business_write_committed`. Старые failed-request receipts сохранены как диагностическая история, не считаются текущим blocker. Dev API работает на final source tree с polling disabled.

Final validation: E2E 8/8; executable 140 files, **1300/1300**; isolated TEST PostgreSQL **63/63**, включая first-turn regression; LSP diagnostics четырёх changed TS files clean. Проверки выполнялись на baseline `86b6b01` + source diff атомарного коммита этого дополнения. Точный implementation commit: `git log -1 --format=%H -- src/infrastructure/postgres/postgres-linked-activity-transaction-store.ts`.

Telegram full business replay из checklist **не требуется**: оставшийся transport smoke ограничен binding chat/employee/thread, actual send receipt, delivered budget и proactive routing. Это не незавершённая проверка activity-сохранения. Старые инструкции ниже о повторении full chain в Telegram superseded этим уточнением. Отдельный `.16` live cycle не запускался.

## Что нужно оператору для завершения внешнего gate

1. Выполнено оператором: `PRIVACY_POLICY_V6_URL` настроен, runtime config и startup проходят; публичное содержимое snapshot отдельно не сравнивалось. Требование: действительный публичный immutable URL соответствует `docs/product/privacy-v6.html`, хранится в private dev env. Не подставлять example URL. Проверенный pinned Git URL текущего локального HEAD недоступен (HTTP 404); snapshot этим способом не подтверждён.
2. Test employee и dev period разрешены/проверены; для реального Telegram подтвердить test chat/thread и consent. Existing CLI env token не соответствует employee/admin principal; для employee CLI выбрать его scoped token приватно, не печатать token и не применять service token к employee plane.
3. Поднять dev API; `npm run cli -- employee profile`, затем `npm run cli -- employee chat --thread <test-thread> --text 'Подготовил отчёт за полчаса'`. Реальное model поведение и PostgreSQL continuity ещё не проверены через HTTP. Не принимать согласие вместо сотрудника.
4. Telegram smoke на том же разрешённом test owner: рассказ выше → дождаться доставленного вопроса → короткий ответ по смыслу вопроса → проверить одну activity/неизменённую длительность; затем «Не хочу продолжать» → итог без новых вопросов, факты сохранены.
5. Перед коротким ответом сделать контролируемый restart dev runtime; проверить восстановленные pending, refs и delivered budget. Отдельно подтвердить успешную proactive delivery и отсутствие competing evening после weekly/final. Реальная доставка не заменяется CLI.
6. Сохранить private canonical delivery/episode/activity evidence, безопасные результаты и exact deployed HEAD добавить сюда; только после pass внешней части закрывать `.15` и разрешать `.16` (с отдельным live manifest). Не включать production при выполнении этих шагов.

Runbook: [work-retrospective-cycle.md](../runbooks/work-retrospective-cycle.md). Live две недели и эффект методики не проверены.
