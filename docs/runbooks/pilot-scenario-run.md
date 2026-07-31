# Ручной прогон пилотного сценария D.0

Этот чек-лист — integration gate фазы D.0 по [планке качества пилота §2.2 п. 4](../architecture/rfc-pilot-quality-bar.md#22-бюджет-ревью). Прогон не является smoke-spec: он занимает два календарных дня, использует живой Telegram и живой LLM и проверяет реальные доставки по расписанию.

Один прогон выполняется для **нового** тестировщика с новым `employeeId` и одноразовым инвайтом. Не переиспользовать профиль от предыдущего прогона: автоматическое провижининг расписаний не перезаписывает уже существующие расписания.

Перед началом отправьте тестировщику [карту навыков текущей версии](../product/skills-map.md). Убедитесь, что он различает статусы «✅ работает / 🚧 подключается / 💭 задумано» и не использует ещё не подключённые функции как критерий прохождения пилота.

## Окно прогона и протокол

Чтобы проверить события в порядке «утро → перенос → вечер», завершить онбординг в день 1 **после 19:00 в таймзоне профиля**. Runtime, PostgreSQL и MinIO должны непрерывно работать как минимум до 19:10 следующего дня.

До начала заполнить:

| Поле | Значение |
|---|---|
| Дата начала | |
| Оператор | |
| Commit / версия deployment | |
| `employeeId` тестировщика | |
| Telegram username тестировщика | |
| Username бота | |
| IANA-таймзона профиля | |
| Время запуска runtime | |
| Итог (`прошло` / `нет`) | |

В таблице шагов ниже для каждого пункта явно написать `прошло` или `нет`, фактическое локальное время и короткое свидетельство: текст/скриншот ответа без инвайт-кода и секретов.

## Предусловия окружения

### 1. Конфигурация

В deployment `.env` должны быть настроены PostgreSQL, MinIO, живой LLM, опубликованная privacy policy и runtime-токены. Подробная первичная настройка описана в [PostgreSQL runbook](./postgres-runtime.md), [MinIO runbook](./minio-local.md) и [HTTP runtime runbook](./http-api-runtime.md).

Для этого прогона обязательно:

- `TELEGRAM_MODE=polling`;
- непустой `TELEGRAM_BOT_TOKEN`;
- непустой `MINUTKA_SERVICE_TOKEN`, через который Telegram shell вызывает application API;
- непустой `MINUTKA_ADMIN_TOKEN` для выдачи инвайта через CLI;
- `INTEGRATION_ENC_KEY` — ровно 32 байта в canonical base64. В polling-режиме конфиг без него падает fail-closed;
- `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `INVITE_CODE_PEPPER` и `TELEGRAM_IDENTITY_PEPPER`;
- application credentials и bucket MinIO;
- рабочие `LLM_MODEL` и provider credentials.

Загрузить `.env`, не печатая значения секретов:

```bash
set -a
. ./.env
set +a

test "$TELEGRAM_MODE" = polling
for name in TELEGRAM_BOT_TOKEN MINUTKA_SERVICE_TOKEN MINUTKA_ADMIN_TOKEN \
  INTEGRATION_ENC_KEY DATABASE_URL MIGRATION_DATABASE_URL \
  INVITE_CODE_PEPPER TELEGRAM_IDENTITY_PEPPER MINIO_ACCESS_KEY \
  MINIO_SECRET_KEY MINIO_BUCKET LLM_MODEL; do
  test -n "$(printenv "$name")" || { echo "Missing required variable: $name"; exit 1; }
done
```

Команда проверяет только наличие значений и не выводит их содержимое.

### 2. PostgreSQL, MinIO и миграции

Для локального/стендового Docker Compose запустить зависимости и проверить их состояние:

```bash
docker compose up -d postgres minio minio-init
docker compose ps -a postgres minio minio-init
curl -fsS http://127.0.0.1:9000/minio/health/ready
```

Ожидается:

- PostgreSQL и MinIO имеют состояние `running`/`healthy`;
- `minio-init` завершился с кодом `0`;
- MinIO health endpoint отвечает без ошибки.

Применить миграции и убедиться, что ожидающих миграций нет:

```bash
npm run db:migrate
npm run db:status
```

Не направлять этот прогон или persistence specs на чужую/production-базу без явного разрешения оператора.

### 3. Импорт базы знаний тестировщика (если она участвует в проверке)

Импорт не является частью онбординга и не запускается автоматически при выдаче инвайта. Если в прогоне нужно проверить персонализацию по существующим owner-документам, выполнить импорт **после применения миграций и проверки MinIO, но до запуска runtime и до первого сообщения тестировщика**. Полная процедура, dry-run, allow-list и rollback описаны в [runbook импорта pilot knowledge base](./pilot-knowledge-base-import.md).

Важно:

- `PILOT_USER_ID` должен точно совпадать с `employeeId`, для которого ниже будет выдан инвайт;
- сначала выполнить dry-run, затем реальный импорт и повторный идемпотентный запуск;
- для нового тестировщика без подготовленного owner vault этот шаг пропустить: пустая база знаний не блокирует базовый D.0 gate;
- импорт для другого `PILOT_USER_ID` не будет виден тестировщику из-за owner scope.

Минимальная последовательность:

```bash
set -a; . ./.env; set +a
export PILOT_USER_ID=<id>
export PILOT_KNOWLEDGE_BASE_ROOT=/home/admin/user_knowledge_base

npm run pilot:knowledge-base:import -- --dry-run
npm run pilot:knowledge-base:import
npm run pilot:knowledge-base:import  # ожидаются только skipped
```

### 4. Runtime с живым Telegram

Запустить shared runtime в polling-режиме под процесс-менеджером, который сохраняет stdout/stderr до завершения прогона:

```bash
TELEGRAM_MODE=polling npm run serve
```

Ожидается строка `Minutka HTTP API listening on ...`, после которой процесс остаётся запущенным. Не очищать PostgreSQL, MinIO или runtime-логи между утренним и вечерним шагами.

### 5. Новый инвайт без правки `.env`

В отдельном терминале настроить standalone CLI на работающий runtime:

```bash
export MINUTKA_API_URL=http://127.0.0.1:8787
export MINUTKA_API_TOKEN="$MINUTKA_ADMIN_TOKEN"
export PILOT_EMPLOYEE_ID=<id>
export PILOT_INVITE_CODE="$(openssl rand -hex 24)"

npm run cli -- admin issue-invite \
  --employee "$PILOT_EMPLOYEE_ID" \
  --invite "$PILOT_INVITE_CODE"
```

Каноническая форма команды:

```bash
npm run cli -- admin issue-invite --employee <id> --invite <code>
```

Правка `TELEGRAM_INVITES` или других значений `.env` для нового тестировщика не требуется; рестарт runtime после выдачи инвайта тоже не требуется. Код одноразовый: не писать его в протокол, логи или issue и не переиспользовать.

Передать тестировщику индивидуальную ссылку:

```text
https://t.me/<BOT_USERNAME>?start=<code>
```

## Чек-лист гейта D.0

Окно ожидания для scheduled delivery — до 10 минут после указанного локального времени. Это покрывает минутный тик планировщика, выполнение живого LLM и доставку Telegram. Если сообщения нет к концу окна, поставить `нет` и перейти к разделу диагностики.

| № | Действие | Критерий `прошло` | Результат (`прошло` / `нет`) | Время и свидетельство |
|---:|---|---|---|---|
| 1 | Тестировщик открывает индивидуальную ссылку и нажимает `/start`. | Бот принимает новый инвайт и показывает актуальный текст согласия с кнопкой `✅ Принимаю`; нет сообщения о недействительной или уже использованной ссылке. | | |
| 2 | Тестировщик читает текст и нажимает `✅ Принимаю`. | Telegram подтверждает согласие и бот начинает онбординг. | | |
| 3 | Тестировщик проходит онбординг, указывает ожидаемую IANA-таймзону и подтверждает анкету; затем открывает переданную оператором [карту навыков](../product/skills-map.md). | Бот подтверждает сохранение профиля и присылает первое приветственное сообщение; тестировщик понимает, какие возможности уже работают, подключаются или только задуманы. | | |
| 4 | Сразу после онбординга тестировщик отправляет `/schedule`. | Показаны два включённых расписания в таймзоне профиля: `Утренний фокус — 09:00 (<timezone>)` и `Вечерняя рефлексия — 19:00 (<timezone>)`. | | |
| 5 | На следующее утро тестировщик не пишет боту до scheduled delivery и ждёт 09:00 в таймзоне профиля. | Не позднее 09:10 приходит содержательное утреннее сообщение `day_focus`, сформированное для этого тестировщика. | | |
| 6 | После утреннего сообщения тестировщик пишет в обычный чат, например: `Перенеси утренний фокус на 10:30 по моему текущему часовому поясу.` Затем отправляет `/schedule`. | Ассистент сообщает об изменении; `/schedule` показывает `Утренний фокус — 10:30 (<timezone>)`. Вечерняя рефлексия остаётся на 19:00. | | |
| 7 | Тестировщик ждёт 19:00 того же дня в таймзоне профиля. | Не позднее 19:10 приходит содержательное вечернее сообщение `evening_reflection` с предложением подвести итоги дня. | | |

Гейт `прошло`, только если все семь шагов имеют результат `прошло`. Любой `нет` означает, что ручной пилотный сценарий D.0 не прошёл; зафиксировать отказ по следующему разделу, не повторяя шаги вслепую и не редактируя durable-данные вручную.

## Что фиксировать при отказе scheduled delivery

Для недоставленного утреннего или вечернего касания сохранить два связанных свидетельства.

### 1. Строка runtime-лога планировщика

Найти и приложить точную строку:

```text
Scheduled process failed (<errorCode>; schedule=...; process=...).
```

Зафиксировать рядом:

- какое касание ожидалось (`day_focus` или `evening_reflection`);
- локальное ожидаемое время и таймзону профиля;
- время обнаружения отказа;
- commit / версию deployment из шапки протокола.

Не прикладывать provider payload, токены, инвайт-код, полный `.env` или пользовательский текст диалога.

### 2. Строка `minutka_private.schedule_fires` со статусом `failed`

С runtime credentials выполнить owner-scoped запрос, подставив тот же `employeeId`, что указан в протоколе:

```bash
export PILOT_EMPLOYEE_ID=<id>

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v employee_id="$PILOT_EMPLOYEE_ID" <<'SQL'
SELECT schedule_id,
       user_id,
       process_id,
       scheduled_for,
       status,
       completed_at,
       error_code,
       created_at
FROM minutka_private.schedule_fires
WHERE user_id = :'employee_id'
  AND status = 'failed'
ORDER BY created_at DESC, schedule_id, scheduled_for
LIMIT 20;
SQL
```

Приложить строку, у которой `process_id`, `schedule_id` и `scheduled_for` соответствуют записи из runtime-лога. Ожидаемые диагностические поля — `status = failed`, непустые `completed_at` и `error_code`.

Если сообщение не пришло, но соответствующей строки `failed` нет, не создавать и не исправлять запись вручную. Сохранить пустой результат запроса вместе с runtime-логом и отметить в протоколе: `failed fire отсутствует`; это отдельный симптом для разбора.

## Завершение прогона

1. Поставить итог `прошло` или `нет` в шапке.
2. Сохранить заполненный протокол и минимальные свидетельства в одобренном оператором месте; не коммитить секреты или персональный диалог.
3. Не удалять профиль, расписания, fire ledger или MinIO-данные до завершения разбора результата.
4. Остановить локальный runtime штатным `SIGINT`/`SIGTERM`; не использовать `docker compose down --volumes` для обычного завершения.
