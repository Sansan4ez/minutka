# Операторский запуск планового процесса по требованию

Команда показывает содержание утреннего, вечернего или недельного сообщения без ожидания расписания и без доставки в Telegram. Она собирает обычный PostgreSQL runtime и вызывает typed use-case `PersonalAssistantService.runScheduledProcess`; прямого доступа к stores у скрипта нет.

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

Недельная личная сводка:

```bash
npm run process:run -- \
  --employee <employeeId> \
  --process weekly_summary
```

Ожидаемое содержание: сводка по собственным активностям сотрудника за последние семь локальных дней — какие категории повторялись, что называлось помехой, какой сигнал энергии был явно назван — и приглашение подтвердить или поправить замеченное. Значения берутся из typed `readWeeklyActivities`; обезличенные строки и данные других участников не читаются. Если данных за окно мало (порог: меньше трёх активностей или меньше двух дней с активностями), ответ прямо говорит о нехватке данных и не называет паттерн. Личный контекст (`updatePersonalContext`) меняется только после явного подтверждения сотрудника, поэтому один запуск команды сам по себе профиль не меняет.

По умолчанию расписание недельного касания — пятница, 17:00 по времени сотрудника (`defaultSchedules` в `src/application/default-schedules.ts`, маска дней `16`). Сотрудник переносит или отключает его теми же `listSchedules` / `setDailySchedule` / `disableSchedule`. День и время калибруются после первой пилотной недели.

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

Допустимые значения `--process`: `morning_planning`, `evening_reflection` и `weekly_summary`.

## Проверка в пилотном прогоне

Сначала проверить планировщик переносом времени расписания: свидетельства — строка runtime-лога и соответствующая запись `minutka_private.schedule_fires`. Затем отдельно проверить содержание:

```bash
npm run process:run -- --employee <employeeId> --process morning_planning --thread <threadId>
npm run process:run -- --employee <employeeId> --process evening_reflection --thread <threadId>
npm run process:run -- --employee <employeeId> --process weekly_summary --thread <threadId>
```

Для каждого запуска зафиксировать код `0` и минимальный фрагмент stdout без персонального диалога. Не считать успешный запуск этой команды свидетельством срабатывания расписания или Telegram-доставки.
