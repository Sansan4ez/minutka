# Операторский запуск планового процесса по требованию

Команда показывает содержание утреннего или вечернего сообщения без ожидания расписания и без доставки в Telegram. Она собирает обычный PostgreSQL runtime и вызывает typed use-case `PersonalAssistantService.runScheduledProcess`; прямого доступа к stores у скрипта нет.

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

Команда открывает собственные подключения к PostgreSQL и MinIO. Одновременно работающий HTTP/Telegram runtime не требуется.

## Запуск

Утреннее планирование:

```bash
npm run process:run -- \
  --employee <employeeId> \
  --process morning_planning
```

Ожидаемое содержание: до трёх приоритетов и один конкретный первый шаг; планы не записываются как activities. Если bounded history показывает пропущенный вечер, допустим один короткий catch-up-вопрос о вчерашних фактах.

Вечерний факт и рефлексия:

```bash
npm run process:run -- \
  --employee <employeeId> \
  --process evening_reflection
```

Ожидаемое содержание: приглашение назвать до трёх фактически выполненных или начатых активностей, препятствие и необязательный рабочий сигнал энергии. `collectActivity` выполняется только после ответа сотрудника, один раз на каждую фактическую activity.

По умолчанию используется ветка `default`. Чтобы проверить bounded continuity утро → добровольный дневной апдейт → вечер, передавайте один и тот же Telegram thread ID:

```bash
npm run process:run -- --employee <employeeId> --process morning_planning --thread <threadId>
npm run process:run -- --employee <employeeId> --process evening_reflection --thread <threadId>
```

`midday_adjustment` намеренно отсутствует в этой команде: это chat-only процесс, который выбирается только в обычном employee turn по инициативе сотрудника. Отдельного scheduled midday id и push нет.

При успехе stdout содержит текст ответа процесса, команда завершается кодом `0`. Ответ и вызов сохраняются в личной истории этой ветки обычным application use-case; Telegram-сообщение не отправляется.

## Отказы

Команда завершается с ненулевым кодом и печатает явную причину в stderr, если:

- неизвестен `processId` или он не входит в `AssistantScheduledProcessId`;
- передан retired `morning_activity_collection`, chat-only `midday_adjustment` или disabled `day_focus`;
- сотрудник отсутствует или ещё не завершил онбординг;
- PostgreSQL, MinIO, миграции или LLM-конфигурация не готовы;
- выполнение процесса завершилось ошибкой.

Допустимые значения `--process`: `morning_planning` и `evening_reflection`.

## Проверка в пилотном прогоне

Сначала проверить планировщик переносом времени расписания: свидетельства — строка runtime-лога и соответствующая запись `minutka_private.schedule_fires`. Затем отдельно проверить содержание:

```bash
npm run process:run -- --employee <employeeId> --process morning_planning --thread <threadId>
npm run process:run -- --employee <employeeId> --process evening_reflection --thread <threadId>
```

Для каждого запуска зафиксировать код `0` и минимальный фрагмент stdout без персонального диалога. Не считать успешный запуск этой команды свидетельством срабатывания расписания или Telegram-доставки.
