# Операторский запуск планового процесса по требованию

Команда показывает содержание утреннего или вечернего касания без ожидания расписания и без доставки в Telegram. Она собирает обычный PostgreSQL runtime и вызывает typed use-case `PersonalAssistantService.runScheduledProcess`; прямого доступа к stores у скрипта нет.

Это проверка **содержания процесса**, а не планировщика. Команда не меняет `minutka_private.process_schedules` и `minutka_private.schedule_fires`. Срабатывание расписания и Telegram-доставка проверяются отдельно в прогоне пилотного сценария.

## Предусловия

1. Загрузить runtime-конфигурацию либо оставить локальный `.env`, который команда загружает тем же способом, что `npm run serve`:

```bash
set -a
. ./.env
set +a
```

2. PostgreSQL и MinIO доступны, миграции применены, настроены живой LLM и provider credentials.
3. Сотрудник существует и завершил онбординг (`status = profile_completed`).

Команда открывает собственные подключения к PostgreSQL и MinIO. Одновременно работающий HTTP/Telegram runtime не требуется и не используется для вызова процесса.

## Запуск

Утренний сбор активностей:

```bash
npm run process:run -- \
  --employee <employeeId> \
  --process morning_activity_collection
```

Вечерняя рефлексия:

```bash
npm run process:run -- \
  --employee <employeeId> \
  --process evening_reflection
```

По умолчанию используется ветка `default`. Чтобы сверить содержание с существующей Telegram-веткой, передать её ID явно:

```bash
npm run process:run -- \
  --employee <employeeId> \
  --process morning_activity_collection \
  --thread <threadId>
```

При успехе stdout содержит текст ответа процесса (после служебного заголовка `npm run`), команда завершается кодом `0`. Ответ и вызов сохраняются в личной истории этой ветки обычным application use-case; Telegram-сообщение не отправляется.

## Отказы

Команда завершается с ненулевым кодом и печатает явную причину в stderr, если:

- неизвестен `processId` или он не входит в `AssistantScheduledProcessId`;
- сотрудник отсутствует;
- сотрудник ещё не завершил онбординг;
- PostgreSQL, MinIO, миграции или LLM-конфигурация не готовы;
- выполнение процесса завершилось ошибкой.

Допустимые значения `--process`: `morning_activity_collection` и `evening_reflection`.

## Проверка утреннего и вечернего касания в пилотном прогоне

В шагах утреннего и вечернего касания сначала проверить планировщик переносом времени расписания: свидетельства — строка runtime-лога и соответствующая запись `minutka_private.schedule_fires`. Затем отдельно проверить содержание:

```bash
npm run process:run -- --employee <employeeId> --process morning_activity_collection --thread <threadId>
npm run process:run -- --employee <employeeId> --process evening_reflection --thread <threadId>
```

Для каждого запуска зафиксировать код `0` и минимальный фрагмент stdout без персонального диалога. Не считать успешный запуск этой команды свидетельством срабатывания расписания или Telegram-доставки.
