# Ежедневный pilot-status отчёт

Отчёт — внутренний артефакт оператора/методолога. Клиентской компании он не передаётся: в отличие от client report, он содержит employee id и внутренние operational counters. Текст переписки, profile-поля `typicalTasks` / `aiLevel` / `programGoal`, `subject_key` и Telegram identifiers в data-блок не попадают.

## Ручной запуск

Из корня репозитория с загруженным production-compatible `.env`:

```bash
npm run pilot:status -- \
  --output reports/pilot-status-latest.html \
  --template docs/reports/pilot-status-template.html \
  --commit "$(git rev-parse --short HEAD)" \
  --smoke passed
```

`DATABASE_URL`, `INVITE_CODE_PEPPER` и `TELEGRAM_IDENTITY_PEPPER` требуются существующим PostgreSQL config boundary. Команда читает БД через typed use-case `PilotStatusService`, проверяет `/healthz`, число pending migrations и атомарно заменяет output-файл.

Дополнительные серверные показатели передаются генератором, а не читаются application use-case:

```bash
npm run pilot:status -- \
  --output /tmp/pilot-status.html \
  --backup-id 20260821T010000Z \
  --unit minutka=active \
  --unit postgresql=active
```

## Состав data-блока

- participant: employee id, company/group labels, role label, onboarding/engagement/last touch и counts messages/activities/traces/schedules/fires;
- activity: `task_category`, `system`, `duration_bucket`, `routine_pattern`, `automation_candidate`, `energy_stress_marker`, `activity_date`;
- messages: count по employee/date;
- health: `/healthz`, pending migrations, fires, trace coverage, feedback count и переданные сервером unit/smoke/backup/commit значения.

Data-блок находится в `<script type="application/json" id="pilot-status-data">`. Текущая схема — `minutka-pilot-status/v2`: она заменяет объединённые `obstacleOtherPercent`/`obstacle_other_above_40` из v1 раздельными routine/automation метриками и добавляет missing coverage. Генератор всегда пишет v2; backward reader для сгенерированных HTML не нужен, потому что фиксированный latest-файл атомарно заменяется целиком вместе с шаблоном. Шаблон [`../reports/pilot-status-template.html`](../reports/pilot-status-template.html) содержит стили и render-JS.

## Rule-based флаги

Баннер строится без ручного нарратива:

- день 5 и позже: coverage завершённого onboarding `< 60%`;
- день 7 и позже: `system=other > 40%` — taxonomy misfit системы;
- день 7 и позже: `routine_pattern=other > 40%` — отдельный taxonomy misfit наблюдаемого паттерна;
- день 7 и позже: `automation_candidate=other > 40%` — отдельный taxonomy misfit automation hypothesis;
- в любой день: появился participant с engagement `dropped_off`.

Доли считаются от всех canonical activities. Рядом показываются `system`, `routine_pattern` и `automation_candidate` missing rates. Omitted facet может быть корректным отсутствием названного факта, поэтому missing не создаёт warning автоматически; оператор сопоставляет его с ожидаемым сценарием сбора. `energy_stress_marker` имеет только missing coverage и не имеет `other`, поэтому отдельная Other-метрика для него не вводится.

## Production timer

NixOS-модуль `nixos/phase3-assistant-stack/modules/pilot-status.nix` запускает `minutka-pilot-status.service` дважды в день и кладёт текущий файл в:

```text
/var/lib/minutka-reports/pilot-status-latest.html
```

Файл не публикуется HTTP-сервисом и в Telegram не отправляется: в ТГ уходят только алерты `minutka-alerting`. Каталог создаётся как `2750 minutka:users`; setgid-бит даёт сгенерированному файлу владельца `minutka`, группу `users` и режим `0640`, поэтому оператор в группе `users` читает его по SSH без `sudo`, а посторонние в каталог не попадают.

Получить свежий отчёт на рабочую машину:

```bash
ssh admin@SERVER "cat /var/lib/minutka-reports/pilot-status-latest.html" > ~/pilot-status.html
```

Имя файла фиксированное: каждая генерация заменяет предыдущий срез, история не ведётся. Сгенерированные `reports/*.html` и `docs/reports/*.html` игнорируются Git; исключение — единственный tracked template.

Проверка таймера:

```bash
systemctl status minutka-pilot-status.timer
sudo systemctl start minutka-pilot-status.service
journalctl -u minutka-pilot-status.service -n 100 --no-pager
ls -l /var/lib/minutka-reports/pilot-status-latest.html
```
