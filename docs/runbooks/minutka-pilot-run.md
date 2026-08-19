# Прогон пилотного сценария «Минутки» через CLI-контур

Это integration gate «Минутки» перед пилотным запуском: сценарий от пустого состояния до выгрузки и удаления данных, выполняемый **агентом или оператором на дев-сервере через CLI-контур**, без живого тестировщика в Telegram. Прогон подтверждает Success Criteria эпика `mnt-minutka-core-launch-uvp` и инварианты [RFC мультитенантного контура](../architecture/rfc-minutka-tenancy-and-reporting.md).

Унаследованный [ручной прогон D.0](./pilot-scenario-run.md) остаётся гейтом фазы ассистента и этим документом не заменяется: там другой контур (живой тестировщик, два календарных дня, Telegram-кнопки), и его утренний процесс `day_focus` в «Минутке» не используется.

## Что прогон проверяет и что не проверяет

Проверяет: справочники тенантности → инвайт → privacy-v6 consent/re-consent → онбординг с выбором `role_id` → плановое утреннее касание → canonical activities и research trace → вечернее касание → изоляция второго сотрудника → subject-aware internal/client report boundary → ручное удаление и пересчёт.

**Не проверяет — решение оператора от 2026-08-17, а не пропуск:**

- **голос (STT).** Подтверждён прежними прогонами; механика распознавания (`src/telegram/telegram-shell.ts`) этим прогоном не затрагивается.
- **генерация инвайт-ссылки и переход по deep-link в Telegram.** Подтверждены прежними прогонами; прогон использует инвайт-код из вывода `admin invite`, а сам переход по ссылке в Telegram не выполняет.

Штатная доставка планового касания в Telegram **отказом прогона не считается**: свидетельством срабатывания служит запись `minutka_private.schedule_fires`, а не сообщение в мессенджере.

Содержание процессов проверяется командой `npm run process:run` ([runbook](./scheduled-process-on-demand.md)), а не ожиданием срабатывания расписания.

## Предусловия дев-сервера

Прод-контур не требуется: прогон выполняется на дев-сервере с собственным контуром запуска.

### 1. Переменные окружения

```bash
set -a
. ./.env
set +a
```

Обязательны: `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `INVITE_CODE_PEPPER`, `TELEGRAM_IDENTITY_PEPPER`, application credentials и bucket MinIO, `LLM_MODEL` с provider credentials, `MINUTKA_ADMIN_TOKEN`, `MINUTKA_SERVICE_TOKEN`.

Отдельно проверить два значения, на которых прогон падает раньше первого шага:

- **`PRIVACY_POLICY_V6_URL`.** Имя переменной выводится из текущей версии согласия (`src/config/privacy.ts`), поэтому `.env` с `PRIVACY_POLICY_V5_URL` не подходит: runtime падает fail-closed на старте. URL должен быть HTTPS, без query и fragment, и содержать `privacy-v6` в пути. Опубликованный snapshot обязан совпадать с `docs/product/privacy-v6.html`.
- **`MINUTKA_EMPLOYEE_TOKENS`** — пары `employeeId:token` через запятую, **минимум на двух сотрудников** одной учебной группы (второй нужен для шага 8). Токен — не меньше 32 символов; все токены принципалов должны различаться (`src/server/http/auth.ts`).

```bash
export EMPLOYEE_ONE=emp_pilot_one
export EMPLOYEE_TWO=emp_pilot_two
export EMPLOYEE_ONE_TOKEN="$(openssl rand -base64 36 | tr -d '\n')"
export EMPLOYEE_TWO_TOKEN="$(openssl rand -base64 36 | tr -d '\n')"
export MINUTKA_EMPLOYEE_TOKENS="$EMPLOYEE_ONE:$EMPLOYEE_ONE_TOKEN,$EMPLOYEE_TWO:$EMPLOYEE_TWO_TOKEN"

for name in DATABASE_URL MIGRATION_DATABASE_URL INVITE_CODE_PEPPER \
  TELEGRAM_IDENTITY_PEPPER MINIO_ACCESS_KEY MINIO_SECRET_KEY MINIO_BUCKET \
  LLM_MODEL MINUTKA_ADMIN_TOKEN MINUTKA_SERVICE_TOKEN PRIVACY_POLICY_V6_URL \
  MINUTKA_EMPLOYEE_TOKENS; do
  test -n "$(printenv "$name")" || { echo "Missing required variable: $name"; exit 1; }
done
```

Команда проверяет только наличие значений и не печатает их содержимое. Токены сотрудников не записывать в протокол.

### 2. PostgreSQL, MinIO, миграции

```bash
docker compose up -d postgres minio minio-init
npm run db:migrate
npm run db:status
```

Ожидается `"pending":[]`. Первичная настройка — [PostgreSQL runbook](./postgres-runtime.md) и [MinIO runbook](./minio-local.md).

### 3. Runtime

```bash
npm run serve   # либо npm run telegram:dev, если нужен и Telegram-контур
```

Ожидается строка `Minutka HTTP API listening on http://127.0.0.1:8787`, после которой процесс остаётся запущенным; stdout/stderr сохранять до конца прогона — из них берутся строки планировщика. Планировщик стартует независимо от `TELEGRAM_MODE` и тикает раз в минуту (`src/runtime/create-postgres-runtime.ts`).

При `TELEGRAM_MODE=disabled` сотрудники существуют только в CLI-контуре: плановое касание срабатывает и фиксируется в журнале, но доставка отсутствует — см. шаг 5.

### 4. CLI

```bash
export MINUTKA_API_URL=http://127.0.0.1:8787
export TELEGRAM_BOT_USERNAME=<bot_username_without_at>
```

Операторские команды выполняются с `MINUTKA_API_TOKEN="$MINUTKA_ADMIN_TOKEN"`, команды сотрудника — с его токеном. Идентичность задаёт исключительно токен: отдельного `--employee` у команд сотрудника нет.

### 5. Чтение БД

`psql` на дев-сервере может отсутствовать. Прогон использует read-only-помощник на пакете `pg` из `node_modules`:

```bash
dbq() { node -e '
const {Client}=require("pg");
const c=new Client({connectionString:process.env.DATABASE_URL});
c.connect().then(()=>c.query(process.argv[1],JSON.parse(process.argv[2]||"[]")))
 .then(r=>{console.log(JSON.stringify(r.rows,null,2));return c.end();})
 .catch(e=>{console.error("ERR",e.message);process.exit(1);});
' "$1" "${2:-[]}"; }
```

Помощник только читает. Durable-данные вручную не править: расхождение фиксируется задачей, а не правкой строки.

## Протокол

До начала заполнить:

| Поле | Значение |
|---|---|
| Дата прогона | |
| Исполнитель | |
| Commit | |
| `employeeId` сотрудника 1 / сотрудника 2 | |
| `companyId` / `groupId` | |
| Таймзона профиля | |
| `TELEGRAM_MODE` | |
| Итог (`прошло` / `нет`) | |

Результаты шагов:

| № | Шаг | Результат (`прошло` / `нет`) | Время | Свидетельство |
|---:|---|---|---|---|
| 1 | Справочники | | | |
| 2 | Инвайт | | | |
| 3 | Consent | | | |
| 4 | Онбординг | | | |
| 5 | Утреннее касание | | | |
| 6 | Активности | | | |
| 7 | Вечернее касание | | | |
| 8 | Изоляция | | | |
| 9 | Выгрузка | | | |
| 10 | Удаление | | | |

Свидетельство — вывод команды, строка БД или строка лога. «Посмотреть в Telegram» свидетельством не является. Гейт `прошло`, только если все десять шагов `прошло`; любой `нет` заводится задачей в `br` со ссылкой на конкретное расхождение.

## Шаг 1. Справочники

Подготовить комплект вне репозитория ([формат](./tenant-reference-directories.md)) и завести его:

```bash
npm run tenant:seed -- seed --file /secure/path/company-pilot.json
npm run tenant:seed -- inspect --company-id "$COMPANY_ID"
npm run tenant:seed -- inspect --company-id company_absent
```

**Признак `прошло`:** `seed` печатает `"status":"created"`; `inspect` по компании прогона показывает одну компанию, одну учебную группу с `periodFrom`/`periodToExclusive` и три должности с их `id`; `inspect` по чужому идентификатору не показывает записей компании прогона.

## Шаг 2. Инвайт

```bash
MINUTKA_API_TOKEN="$MINUTKA_ADMIN_TOKEN" npm run cli -- admin invite \
  --employee "$EMPLOYEE_ONE" --company "$COMPANY_ID" --group "$GROUP_ID"
```

Код печатается один раз и хранится только как digest. Сохранить его в переменную оболочки для шага 3 и **не записывать в протокол, лог или задачу**.

**Признак `прошло`:** вывод содержит `"status":"invite_issued"` и `"created":true`, затем строку `https://t.me/<bot>?start=<code>`. Повтор той же команды завершается ошибкой `employee already has an active invite` и кодом возврата `1`.

Повторить для второго сотрудника — он нужен на шаге 8.

## Шаг 3. Consent

```bash
npm run cli -- employee open-invite --invite "$INVITE_CODE_ONE" | tail -n 1
```

Сверить короткий текст согласия с процессом между маркерами `minutka-consent-short` — он является текстом оферты на транспортной границе; полный текст между `minutka-consent-full` доступен в Telegram по кнопке «📄 Подробнее» (`src/application/consent-process-loader.ts`):

```bash
npm run cli -- employee open-invite --invite "$INVITE_CODE_ONE" | tail -n 1 > /tmp/open-invite.json
node -e '
const fs=require("node:fs");
const md=fs.readFileSync("vault/assistant/processes/consent_and_privacy.md","utf8");
const s=md.indexOf("<!-- minutka-consent-short:start -->"), e=md.indexOf("<!-- minutka-consent-short:end -->");
const expected=md.slice(s+"<!-- minutka-consent-short:start -->".length,e).trim()
  .replace("{{privacyPolicyUrl}}",process.env.PRIVACY_POLICY_V6_URL);
const actual=JSON.parse(fs.readFileSync("/tmp/open-invite.json","utf8"));
console.log(JSON.stringify({privacyVersion:actual.privacyVersion,textMatches:actual.privacyExplanation===expected}));
'
MINUTKA_API_TOKEN="$EMPLOYEE_ONE_TOKEN" npm run cli -- employee accept-consent --yes | tail -n 1
```

**Признак `прошло`:** ответ `open-invite` содержит короткий `privacyExplanation` с full corpus/traces, manual analysis + prompt/taxonomy improvement + evaluation, явным исключением model training, company client-report boundary и manual retention; `"privacyVersion":"privacy-v6"`, сверка печатает `"textMatches":true`; `accept-consent` возвращает `privacy-v6` и непустой `acceptedAt`. Согласие без `--yes` отклоняется с причиной `privacy consent must be explicitly accepted`. Сессия с `privacy-v5` получает re-consent prompt, а её текст/voice не попадает в conversation/research stores до принятия v6.

Повторить `open-invite` и `accept-consent` для второго сотрудника.

## Шаг 4. Онбординг

Сначала — отказ на должности чужой компании:

```bash
MINUTKA_API_TOKEN="$EMPLOYEE_ONE_TOKEN" npm run cli -- employee complete-onboarding \
  --role-id role_of_another_company --persona support --timezone Europe/Moscow
```

Затем — штатное завершение со своей должностью:

```bash
MINUTKA_API_TOKEN="$EMPLOYEE_ONE_TOKEN" npm run cli -- employee complete-onboarding \
  --name Алексей --role-id "$ROLE_ID" --persona support \
  --response-length balanced --timezone Europe/Moscow | tail -n 1
MINUTKA_API_TOKEN="$EMPLOYEE_ONE_TOKEN" npm run cli -- employee profile | tail -n 1
dbq "SELECT schedule_id, process_id, time_of_day, days_of_week, timezone, enabled, next_fire_at
     FROM minutka_private.process_schedules WHERE user_id = \$1 ORDER BY process_id" "[\"$EMPLOYEE_ONE\"]"
```

**Признак `прошло`:** чужая должность отклоняется причиной `roleId must belong to the participant company` (HTTP 400, код ошибки `invalid_request`) и кодом возврата `1`, ответа `Internal server error.` быть не должно; своя должность даёт `"status":"profile_completed"` с этим `roleId`; профиль показывает выбранную должность, таймзону и `"preferredName":"Алексей"` из флага `--name`; провижинятся ровно два расписания — `morning_planning` на `08:30` и `evening_reflection` на `19:00`, оба с понедельника по пятницу (`days_of_week = 31`) в таймзоне профиля. `day_focus`, retired `morning_activity_collection` и отдельный midday process в расписаниях отсутствуют.

Онбординг второго сотрудника выполняется так же — с должностью своей компании.

## Шаг 5. Утреннее касание

Плановое касание проверяется **переносом времени расписания на ближайшие минуты**, а не ожиданием штатных 08:30. Перенос выполняется обычным разговором: агент вызывает `setDailySchedule` (`src/mastra/tools/schedule-tools.ts`).

```bash
MINUTKA_API_TOKEN="$EMPLOYEE_ONE_TOKEN" npm run cli -- employee chat \
  --text "Перенеси утреннее планирование на 09:37 по моему часовому поясу." | tail -n 1

dbq "SELECT process_id, time_of_day, timezone, next_fire_at
     FROM minutka_private.process_schedules WHERE user_id = \$1" "[\"$EMPLOYEE_ONE\"]"
```

Подставить ближайшее время в таймзоне профиля (2–3 минуты вперёд). Дождаться тика планировщика (интервал — 60 секунд) и прочитать журнал:

```bash
dbq "SELECT schedule_id, process_id, scheduled_for, status, completed_at, error_code
     FROM minutka_private.schedule_fires WHERE user_id = \$1
     ORDER BY created_at DESC LIMIT 10" "[\"$EMPLOYEE_ONE\"]"
```

**Признак `прошло`:**

- запись `minutka_private.schedule_fires` с `process_id = morning_planning` и `scheduled_for`, равным перенесённому моменту. `day_focus` и `midday_adjustment` в журнале не появляются;
- `next_fire_at` расписания после срабатывания приходится на **следующий день в то же локальное время таймзоны профиля** — граница дня берётся из профиля, а не из UTC;
- статус записи:
  - `succeeded` — если сотрудник привязан к Telegram и доставка ушла штатно;
  - `failed` с `error_code = TelegramDeliveryNotConfiguredError` (при `TELEGRAM_MODE=disabled`) или `TelegramDeliverySessionNotFoundError` (сотрудник только в CLI-контуре) и строкой лога `Scheduled action failed (<errorCode>; schedule=...; kind=process).`

Оба статуса подтверждают срабатывание планировщика: `process_id` и `scheduled_for` фиксируются до доставки. Отказом прогона считается только отсутствие записи или чужой `process_id`.

Содержание процесса проверяется отдельно и без ожидания:

```bash
npm run process:run -- --employee "$EMPLOYEE_ONE" --process morning_planning --thread pilot-daily
```

**Признак `прошло`:** команда завершается кодом `0` и предлагает выбрать не более трёх приоритетов и один конкретный первый шаг. В ответе нет утверждения о сохранении planned work, а в `minutka_private.activities` после одного scheduled prompt новых строк нет. Строки `Assistant thread compaction audit failed (PersistenceError).` в выводе быть не должно.

## Шаг 6. Добровольный дневной апдейт и вечерние активности

Сначала в том же thread добровольно сообщить об изменении плана. Это обычный employee chat, не `process:run`: отдельного midday schedule нет. Ответ должен опираться на видимый утренний план, оставить до трёх приоритетов и один следующий шаг, не создавая activity для планов.

Затем вечером назвать три фактические активности в одном разговоре:

```bash
MINUTKA_API_TOKEN="$EMPLOYEE_ONE_TOKEN" npm run cli -- employee chat \
  --text "Сегодня час собирал отчёт по продажам в 1С — половину времени искал данные; потом сорок минут созванивался с логистом по срокам; и ещё полчаса вручную переносил заявки из почты в CRM." | tail -n 1

dbq "SELECT activity_id, subject_key, company_id, group_id, role_id, task_category,
            obstacle_kind, duration_bucket, system, recorded_at
     FROM minutka_private.activities WHERE employee_id = \$1 ORDER BY recorded_at" "[\"$EMPLOYEE_ONE\"]"
dbq "SELECT trace_id, subject_key, status, prompt_version, taxonomy_version, model
     FROM minutka_research.traces WHERE company_id = \$1 AND group_id = \$2 ORDER BY started_at DESC"
    "[\"$COMPANY_ID\",\"$GROUP_ID\"]"
```

**Признак `прошло`:** `selectedProcessIds` содержит `evening_reflection`; три canonical activities содержат один и тот же subject binding сотрудника, `source_message_id` текущего turn, локальную `activity_date` и точный company/group scope; conversation turn и full research trace сохранены. Planned/not-started work не создаёт строк. Research export выбранной группы связывает messages, activities и traces по subject/evidence refs. Отдельной reporting-копии activity нет.

Расхождение прогонов от 2026-08-17 (ответ сохранялся как «идея» унаследованного ассистента, обе таблицы оставались пустыми) закрыто в два приёма: `mnt-pilot-readiness-w73.10` убрал инструменты отключённых процессов, включая `captureIdea`, из активного набора агента, а `mnt-pilot-readiness-w73.13` вернул модели правило «одна помеха на активность» в описание инструмента (cross-field `.refine()` не доходил до провайдера) и снял fallback-гейт «не терять ввод». С commit `62ffea2` шаг проходит: три активности одним сообщением дают три canonical subject-linked записи, `inbox_capture` в `selectedProcessIds` не появляется, `minutka_private.ideas` пуста.

## Шаг 7. Вечернее касание

Повторить процедуру шага 5 для `evening_reflection`:

```bash
MINUTKA_API_TOKEN="$EMPLOYEE_ONE_TOKEN" npm run cli -- employee chat \
  --text "Перенеси вечернюю рефлексию на 19:41 по моему часовому поясу." | tail -n 1
npm run process:run -- --employee "$EMPLOYEE_ONE" --process evening_reflection --thread pilot-daily
```

**Признак `прошло`:** запись `schedule_fires` с `process_id = evening_reflection` и перенесённым `scheduled_for`; `npm run process:run` просит назвать результат, препятствие и необязательный рабочий сигнал энергии и завершается кодом `0`. На ответ сотрудника одна named factual activity даёт ровно один `collectActivity`; неизвестные поля отсутствуют, а не выдуманы.

## Шаг 8. Изоляция

Все команды — с токеном **второго** сотрудника той же учебной группы:

```bash
MINUTKA_API_TOKEN="$EMPLOYEE_TWO_TOKEN" npm run cli -- employee profile | tail -n 1
MINUTKA_API_TOKEN="$EMPLOYEE_TWO_TOKEN" npm run cli -- employee insights | tail -n 1
MINUTKA_API_TOKEN="$EMPLOYEE_TWO_TOKEN" npm run cli -- employee chat \
  --text "Что я записывал сегодня?" | tail -n 1
```

**Признак `прошло`:** `profile` возвращает только второго сотрудника; `insights` не содержит выводов первого; ответ агента не пересказывает активности первого сотрудника и не называет его имя. Личный контур второго сотрудника пуст, хотя оба состоят в одной группе.

## Шаг 9. Выгрузка

```bash
MINUTKA_API_TOKEN="$MINUTKA_ADMIN_TOKEN" npm run cli -- admin company-report \
  --company "$COMPANY_ID" --group "$GROUP_ID" | tail -n 1
```

**Признак `прошло`:** ответ содержит отдельные `internal` и `client` DTO. Internal coverage считает distinct subjects, observations и active dates и помечает evidence как `hypothesis`, `signal` или `confirmed`. Client DTO не содержит subject keys, employee ids, raw messages, traces и evidence refs; слабое evidence остаётся hypothesis/`insufficientEvidence`, а не скрывается универсальным порогом.

## Шаг 10. Удаление

Удаление личных данных требует level-2 подтверждения строкой `DELETE <employee_id>` на stdin:

```bash
printf 'DELETE %s\n' "$EMPLOYEE_ONE" | npm run employee:data:delete -- "$EMPLOYEE_ONE"
dbq "SELECT count(*)::int AS participants FROM minutka_private.participants WHERE employee_id = \$1" "[\"$EMPLOYEE_ONE\"]"
dbq "SELECT count(*)::int AS schedules FROM minutka_private.process_schedules WHERE user_id = \$1" "[\"$EMPLOYEE_ONE\"]"
```

**Признак `прошло`:** команда печатает scope удаления и завершается кодом `0`; участник, профиль, расписания, журнал срабатываний и личные активности исчезли; canonical records других сотрудников и компаний не затронуты; неверная строка подтверждения отклоняется с `confirmation did not match; nothing was deleted`.

## Что фиксировать при отказе доставки по расписанию

Раздел сохранён из [унаследованного прогона D.0](./pilot-scenario-run.md) — с поправкой на фактическую строку лога.

### 1. Строка лога планировщика

```text
Scheduled action failed (<errorCode>; schedule=<scheduleId>; kind=process).
```

Строку печатает `logSchedulerFailure` (`src/application/scheduler-service.ts`). Отдельный отказ тика выглядит как `Scheduler tick failed (<errorName>).`. Зафиксировать рядом: какое касание ожидалось (`morning_activity_collection` или `evening_reflection`), локальное ожидаемое время и таймзону профиля, время обнаружения, commit.

Не прикладывать provider payload, токены, инвайт-код, `.env` или текст диалога.

### 2. Строка `minutka_private.schedule_fires` со статусом `failed`

```bash
dbq "SELECT schedule_id, user_id, process_id, scheduled_for, status, completed_at, error_code, created_at
     FROM minutka_private.schedule_fires
     WHERE user_id = \$1 AND status = 'failed'
     ORDER BY created_at DESC LIMIT 20" "[\"$EMPLOYEE_ONE\"]"
```

Приложить строку, у которой `process_id`, `schedule_id` и `scheduled_for` соответствуют записи из лога. Ожидаемые диагностические поля — `status = failed`, непустые `completed_at` и `error_code`.

Если касания нет, но и строки `failed` нет, запись **не создавать и не исправлять вручную**: сохранить пустой результат запроса вместе со строками лога и отметить в протоколе `failed fire отсутствует` — это отдельный симптом для разбора.

## Выполненные прогоны

### 2026-08-17, дев-сервер, commit `0ccad50`

Контур: `TELEGRAM_MODE=disabled`, два сотрудника (`emp_pilotrun_one`, `emp_pilotrun_two`) в компании `company_pilotrun`, группе `group_pilotrun_2026_08`, таймзона профиля `Europe/Moscow`. Итог: **нет** — шаги 4 и 6 не прошли.

| № | Шаг | Результат | Свидетельство |
|---:|---|---|---|
| 1 | Справочники | прошло | `seed` → `"status":"created"`, повтор → `"already_exists"`; `inspect` по своей компании даёт три должности, по чужой — только её записи |
| 2 | Инвайт | прошло | `"status":"invite_issued"`, `"created":true`, deep-link напечатан один раз; повтор отклонён `employee already has an active invite` |
| 3 | Consent | прошло | `"privacyVersion":"privacy-v4"`, сверка текста с блоком `minutka-consent` → `"textMatches":true`; без `--yes` отказ `privacy consent must be explicitly accepted` |
| 4 | Онбординг | **нет** | должность своей компании → `"status":"profile_completed"`, расписания `morning_activity_collection` 09:00 и `evening_reflection` 19:00 (`Europe/Moscow`), `day_focus` нет. Чужая должность отклонена, но ответом `Internal server error.` — `mnt-pilot-readiness-w73.8`; флаг `--name` потерян — `mnt-pilot-readiness-w73.9` |
| 5 | Утреннее касание | прошло | перенос на 05:03 через `employee chat`; `schedule_fires`: `morning_activity_collection`, `scheduled_for 2026-08-17T02:03:00Z`, `status failed`, `error_code TelegramDeliveryNotConfiguredError`; лог `Scheduled action failed (…; kind=process).`; `next_fire_at` → `2026-08-18 05:03` в таймзоне профиля; `npm run process:run` печатает приглашение назвать 1–3 активности |
| 6 | Активности | **нет** | ответ с тремя активностями трижды сохранён как «идея» (`captureIdea`), `minutka_private.activities` пуста — `mnt-pilot-readiness-w73.10` |
| 7 | Вечернее касание | прошло | перенос на 05:08; `schedule_fires`: `evening_reflection`, `scheduled_for 2026-08-17T02:08:00Z`, лог планировщика; `next_fire_at` → `2026-08-18 05:08`; `npm run process:run` печатает вечернюю рефлексию |
| 8 | Изоляция | прошло | у второго сотрудника свой профиль, пустые `insights`, вопрос о чужих данных отклонён с явной причиной, активности первого не пересказаны |
| 9 | Выгрузка | прошло | `{"status":"refused",…"insufficient_participants":actual 2/required 5,"insufficient_rows":actual 0/required 5}`; ветка отказа среза по должности в контуре из двух сотрудников не достигается (порог группы срабатывает раньше) — покрыта `SPEC-MINUTKA-COMPANY-REPORT-001` |
| 10 | Удаление | прошло | `employee:data:delete` удалил профиль, 2 расписания, 2 записи журнала, 3 идеи, 28 audit-событий, 16 usage-записей, 4 версии объектов MinIO; второй сотрудник и маркер `employee_data_deleted` сохранены; неверное подтверждение ничего не удаляет |

Предусловия дев-сервера, потребовавшие правки на месте: в `.env` была `PRIVACY_POLICY_V2_URL` вместо `PRIVACY_POLICY_V4_URL`, и `MINUTKA_EMPLOYEE_TOKENS` была закомментирована — обе переменные заданы в оболочке прогона. Голос и генерация инвайт-ссылки в Telegram не проверялись по решению оператора.

### 2026-08-17, дев-сервер, повторный прогон, commit `e3f0c80`

Прогон по задаче `mnt-pilot-readiness-w73.12` после закрытия `mnt-pilot-readiness-w73.8`, `.9` и `.10`. Контур: `TELEGRAM_MODE=disabled`, компания `company_pilotrun`, группа `group_pilotrun_2026_08`, таймзона профилей `Europe/Moscow`. Справочники и `emp_pilotrun_two` сохранились с прошлого прогона; `emp_pilotrun_one` заведён заново по инвайту. Для проверки порога шага 9 в ту же группу добавлены четыре участника `role_pilotrun_sales` (`emp_pilotrun_three`…`six`), их токены жили только в оболочке прогона. Итог: **нет** — шаг 6 не прошёл.

| № | Шаг | Результат | Свидетельство |
|---:|---|---|---|
| 1 | Справочники | прошло | `seed` того же комплекта → `"status": "already_exists"` (контур не переводился); `inspect company_pilotrun` → группа `2026-08-01`…`2026-09-01` и три должности; `inspect company_other` → только её записи; `inspect company_absent` → `"groups": [], "roles": []` |
| 2 | Инвайт | прошло | `"status":"invite_issued","created":true` и deep-link один раз для каждого нового сотрудника; повтор для уже онбординнутого `emp_pilotrun_two` → `employee already has an active invite`, код возврата `1` |
| 3 | Consent | прошло | `open-invite` → `"status":"invite_opened"`, `"privacyVersion":"privacy-v4"`; сверка с блоком `minutka-consent` → `{"privacyVersion":"privacy-v4","textMatches":true}`; `accept-consent` без `--yes` → `privacy consent must be explicitly accepted`, с `--yes` → `privacy-v4` и непустой `acceptedAt` |
| 4 | Онбординг | прошло | чужая должность (`role_of_another_company` и реальная `role_other_sales` компании `company_other`) → `roleId must belong to the participant company`, HTTP `400` с кодом `invalid_request`, код возврата `1`, `Internal server error.` нет (`mnt-pilot-readiness-w73.8`); своя должность → `"status":"profile_completed"` с `role_pilotrun_sales` и `"preferredName":"Алексей"` из `--name` (`mnt-pilot-readiness-w73.9`); ровно два расписания — `morning_activity_collection` 09:00 и `evening_reflection` 19:00 в `Europe/Moscow`, `day_focus` отсутствует |
| 5 | Утреннее касание | прошло | перенос на 09:52 через `employee chat`; `schedule_fires`: `morning_activity_collection`, `scheduled_for 2026-08-17T06:52:00Z`, `status failed`, `error_code TelegramDeliveryNotConfiguredError`, лог `Scheduled action failed (…; schedule=emp_pilotrun_one:morning_activity_collection-daily; kind=process).`; `next_fire_at 2026-08-18T06:52:00Z` — следующий день, то же локальное время; `npm run process:run` → код `0` и приглашение назвать 1–3 активности (плюс известная строка `Assistant thread compaction audit failed (PersistenceError).`, `mnt-pilot-readiness-w73.11`) |
| 6 | Активности | **нет** | ответ с тремя активностями → `"Сохранил идею: …"`, `selectedProcessIds ["core","morning_activity_collection","inbox_capture"]`, `effect "business_write_committed"`; `minutka_private.activities` пуста, запись ушла в `minutka_private.ideas` (audit `idea_captured`). Воспроизведено четырьмя формулировками, включая точные словарные значения и чистый тред. Инструмент `captureIdea` в наборе агента отсутствует — запись делает fallback-гейт `AssistantService.chat`, когда ход агента заканчивается без текста и эффекта (`llmSteps: 4`, потолок `maxSteps`). Задача — `mnt-pilot-readiness-w73.13` |
| 7 | Вечернее касание | прошло | перенос на 10:07 через `employee chat`; `schedule_fires`: `evening_reflection`, `scheduled_for 2026-08-17T07:07:00Z`, `status failed`, `error_code TelegramDeliveryNotConfiguredError`, строка лога планировщика; `next_fire_at 2026-08-18T07:07:00Z`; `npm run process:run` → код `0` и вечерняя рефлексия с предложением подвести итоги дня |
| 8 | Изоляция | прошло | у `emp_pilotrun_two` свой профиль, `insights` → `[]`, на вопрос «что я записывал сегодня?» агент отвечает, что записей в его контексте нет; активности и имя первого сотрудника не названы |
| 9 | Выгрузка | прошло | `{"status":"refused",…"insufficient_rows": actual 0 / required 5}` — участников в группе шесть, порог участников пройден, отказ остался по строкам. Ветка отказа среза по должности снова не наблюдалась: строк нет из-за шага 6 — покрыта `SPEC-MINUTKA-COMPANY-REPORT-001` |
| 10 | Удаление | прошло | `employee:data:delete` удалил профиль, участника, 2 расписания, 2 записи журнала, 3 разговора, 8 сообщений, 4 идеи, 25 audit-событий, 16 usage-записей, 4 версии объектов MinIO; `emp_pilotrun_two`…`six`, canonical records других компаний и маркер `employee_data_deleted` сохранены; неверная строка подтверждения → `confirmation did not match; nothing was deleted` |

Механика прогона, не относящаяся к продукту: код первого инвайта `emp_pilotrun_one` был потерян оболочкой прогона до шага 3, участник удалён `employee:data:delete` и инвайт выпущен заново. Голос и переход по инвайт-ссылке в Telegram не проверялись по решению оператора.

### 2026-08-17, дев-сервер, частичный прогон шагов 6 и 9, commit `62ffea2`

Прогон только двух шагов по решению оператора: шаг 6 после починки `mnt-pilot-readiness-w73.13`, шаг 9 — на непустом обезличенном срезе, которого прежние прогоны не получили. Итог гейта не ставится: остальные восемь шагов в этом прогоне не выполнялись, `mnt-pilot-readiness-w73.12` остаётся открытой.

Контур: `TELEGRAM_MODE=disabled`, компания `company_pilotrun`, группа `group_pilotrun_2026_08`, таймзона профилей `Europe/Moscow`. Справочники и `emp_pilotrun_two`…`six` сохранились с прошлого прогона; `emp_pilotrun_one` заведён заново (инвайт → consent → онбординг с `role_pilotrun_sales`, `--name Алексей`), чтобы у должности стало пять участников при шести в группе.

| № | Шаг | Результат | Свидетельство |
|---:|---|---|---|
| 6 | Активности | прошло | ответ с тремя активностями → `"Записал 3 активности: …"`, `selectedProcessIds ["core","morning_activity_collection"]` (без `inbox_capture`), `effect "business_write_committed"`; `minutka_private.activities` — 3 canonical строки у `emp_pilotrun_one`; `minutka_private.ideas` пуста |
| 9 | Выгрузка | прошло | на 3 строках — `{"status":"refused",…"insufficient_rows": actual 3 / required 5}`; после касания логиста (6 строк, 6 участников) группа → `"status":"exported"`, срез `role_pilotrun_sales` (5 участников, 3 строки) → `"status":"refused"` с `insufficient_rows 3/5`, `role_pilotrun_logistics` по имени не назван и слит в `other` → `"status":"refused"` с `insufficient_participants 1/5` и `insufficient_rows 3/5`; после третьего касания (9 строк) срез `role_pilotrun_sales` → `"status":"exported"`, 6 агрегатов без идентификатора сотрудника и свободного текста, `other` по-прежнему `refused` |

Ветка отказа среза по должности, которую прежние прогоны не наблюдали, воспроизведена вживую — ссылка на `SPEC-MINUTKA-COMPANY-REPORT-001` для неё больше не нужна.

Историческое расхождение даты activity закрыто задачей `mnt-pilot-readiness-w73.14`; текущая canonical запись хранит отдельную локальную `activity_date`.

Состояние исторического прогона предшествовало canonical cleanup; полный новый прогон начинается на мигрированной базе и использует subject-scoped deletion/recompute. Токены сотрудников `three`…`six` жили только в оболочке прогона.

### 2026-08-17, дев-сервер, частичный прогон шагов 5, 7, 8 и 10, commit `b384dda`

Прогон оставшихся четырёх шагов по решению оператора: шаги 1–4 подтверждены прогоном на `e3f0c80`, шаги 6 и 9 — частичным прогоном на `62ffea2`, здесь добираются шаги, которые ещё не выполнялись на текущем коде. Контур продолжает предыдущий прогон: `TELEGRAM_MODE=disabled`, компания `company_pilotrun`, группа `group_pilotrun_2026_08`, шесть участников, таймзона профилей `Europe/Moscow`.

| № | Шаг | Результат | Свидетельство |
|---:|---|---|---|
| 5 | Утреннее касание | прошло | перенос на 11:23 через `employee chat` (`effect "business_write_committed"`); `schedule_fires`: `morning_activity_collection`, `scheduled_for 2026-08-17T08:23:00Z`, `status failed`, `error_code TelegramDeliveryNotConfiguredError`, лог `Scheduled action failed (…; schedule=emp_pilotrun_one:morning_activity_collection-daily; kind=process).`; `next_fire_at 2026-08-18T08:23:00Z` — следующий день, то же локальное время; `npm run process:run` → код `0` и приглашение назвать 1–3 активности, строки `Assistant thread compaction audit failed (PersistenceError).` больше нет (`mnt-pilot-readiness-w73.11`) |
| 7 | Вечернее касание | прошло | перенос на 11:27 через `employee chat`; `schedule_fires`: `evening_reflection`, `scheduled_for 2026-08-17T08:27:00Z`, `status failed`, `error_code TelegramDeliveryNotConfiguredError`, строка лога планировщика; `next_fire_at 2026-08-18T08:27:00Z`; `npm run process:run` → код `0` и вечерняя рефлексия с предложением подвести итоги дня |
| 8 | Изоляция | прошло | вторым сотрудником взят `emp_pilotrun_four` (та же группа, личный контур пуст): `profile` возвращает только его (`"preferredName":"Вера"`), `insights` → `[]`, на вопрос «что я записывал сегодня?» агент отвечает, что записей в его контексте нет; активности и имя `emp_pilotrun_one` не названы |
| 10 | Удаление | прошло | `employee:data:delete emp_pilotrun_one` → код `0` и scope: участник, профиль, согласие, 1 разговор, 6 сообщений, 3 активности, 2 расписания, 2 записи журнала, 20 audit-событий, 12 usage-записей, 4 версии объектов MinIO; `emp_pilotrun_two`…`six` и их личные активности сохранены, маркер `employee_data_deleted` записан |

Шаг 8 выполнен не на `emp_pilotrun_two`, как в предыдущих прогонах: у него после подготовки шага 9 появились собственные активности, а признак шага требует пустого личного контура. `emp_pilotrun_four` — участник той же группы, онбординг прошёл, активностей не вводил.

Механика прогона, не относящаяся к продукту: локальный LLM-шлюз около минуты отдавал `auth_unavailable` и несколько раз `Our servers are currently overloaded` — `npm run process:run` в эти моменты падал кодом `1`; после восстановления шлюза оба процесса отработали кодом `0` с первой попытки. Голос и переход по инвайт-ссылке в Telegram не проверялись по решению оператора.

### Итог гейта `mnt-pilot-readiness-w73.12`: прошло

Все десять шагов выполнены на дев-сервере и дали `прошло`, но не одним проходом: шаги 1–4 — на `e3f0c80`, шаги 6 и 9 — на `62ffea2` (расхождение дат закрыто `mnt-pilot-readiness-w73.14` и перепроверено на том же срезе), шаги 5, 7, 8 и 10 — на `b384dda`. Так решил оператор: контур между прогонами не пересобирался, а каждая починка между ними затрагивала только те шаги, которые после неё и перевыполнялись. Ни один шаг не остался неподтверждённым на текущем коде.

## Завершение прогона

1. Поставить итог `прошло` или `нет` в шапке протокола.
2. Сохранить протокол и минимальные свидетельства в одобренном оператором месте; не коммитить секреты, инвайт-коды и персональный диалог.
3. Каждое расхождение завести задачей в `br` со ссылкой на конкретный пункт RFC, брифа, процесса или код.
4. Остановить runtime штатным `SIGINT`/`SIGTERM`; `docker compose down --volumes` для обычного завершения не использовать.
