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
- activity: `task_category`, `system`, `duration_bucket`, `obstacle_kind`, `obstacle_value`, `activity_date`;
- messages: count по employee/date;
- health: `/healthz`, pending migrations, fires, trace coverage, feedback count и переданные сервером unit/smoke/backup/commit значения.

Data-блок находится в `<script type="application/json" id="pilot-status-data">`. Шаблон [`../reports/pilot-status-template.html`](../reports/pilot-status-template.html) содержит стили и render-JS; изменение его вёрстки не меняет use-case.

## Rule-based флаги

Баннер строится без ручного нарратива:

- день 5 и позже: coverage завершённого onboarding `< 60%`;
- день 7 и позже: `system=other > 40%`;
- день 7 и позже: `obstacle_value=other > 40%`;
- в любой день: появился participant с engagement `dropped_off`.

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
