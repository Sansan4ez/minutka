# Integration gate ретроспективы — `mnt-hf3h.15`

## Outcome и проверенная ревизия

**Offline / isolated PostgreSQL: PASS. Dev HTTP / live Telegram: BLOCKED. Общий gate не green; `.16` не запускать.**

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

## Что нужно оператору для завершения внешнего gate

1. Предоставить действительный публичный immutable `PRIVACY_POLICY_V6_URL`, соответствующий `docs/product/privacy-v6.html`; сохранить в private dev env. Не подставлять example URL. Проверенный pinned Git URL текущего локального HEAD недоступен (HTTP 404); snapshot этим способом не подтверждён.
2. Выбрать разрешённый dev test employee/chat/thread и подтвердить active group period, current consent и профиль. Existing CLI env token не соответствует employee/admin principal; для employee CLI выбрать его scoped token приватно, не печатать token и не применять service token к employee plane.
3. Поднять dev API; `npm run cli -- employee profile`, затем `npm run cli -- employee chat --thread <test-thread> --text 'Подготовил отчёт за полчаса'`. Реальное model поведение и PostgreSQL continuity ещё не проверены через HTTP. Не принимать согласие вместо сотрудника.
4. Telegram smoke на том же разрешённом test owner: рассказ выше → дождаться доставленного вопроса → короткий ответ по смыслу вопроса → проверить одну activity/неизменённую длительность; затем «Не хочу продолжать» → итог без новых вопросов, факты сохранены.
5. Перед коротким ответом сделать контролируемый restart dev runtime; проверить восстановленные pending, refs и delivered budget. Отдельно подтвердить успешную proactive delivery и отсутствие competing evening после weekly/final. Реальная доставка не заменяется CLI.
6. Сохранить private canonical delivery/episode/activity evidence, безопасные результаты и exact deployed HEAD добавить сюда; только после pass внешней части закрывать `.15` и разрешать `.16` (с отдельным live manifest). Не включать production при выполнении этих шагов.

Runbook: [work-retrospective-cycle.md](../runbooks/work-retrospective-cycle.md). Live две недели и эффект методики не проверены.
