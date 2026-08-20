# Smoke и метрики production

> Стек унаследован от персонального ассистента и адаптирован под отдельный production-контур «Минутки»: собственный хост, unit names, storage paths и secrets bundle. Живые продуктовые и privacy-решения: [RFC «Минутки»](../architecture/rfc-minutka-tenancy-and-reporting.md).


Production stack проверяет доступность приложения каждые 15 минут и отдаёт
минимальный набор Prometheus-метрик через `node_exporter`. Exporter слушает
только `127.0.0.1:9100`: наружу порт не открыт, смотреть метрики нужно через
локальный SSH-туннель.

## Быстрая проверка на сервере

```bash
sudo systemctl status \
  minutka-smoke.timer \
  minutka-observability-collector.timer \
  prometheus-node-exporter.service
sudo systemctl list-timers \
  minutka-smoke.timer \
  minutka-observability-collector.timer
sudo systemctl start minutka-smoke.service
sudo systemctl start minutka-observability-collector.service
sudo journalctl -u minutka-smoke.service --since today
curl -fsS http://127.0.0.1:9100/metrics | grep '^minutka_'
```

Smoke требует активные `postgresql.service`, `minio.service` и
`minutka.service`, затем проверяет
`http://127.0.0.1:8787/healthz`. Только полностью успешный запуск обновляет
`/var/lib/minutka-observability/smoke.last_success`.

## Доступ через SSH-туннель

На локальной машине:

```bash
ssh -N -L 19100:127.0.0.1:9100 admin@SERVER_IP
```

В другом терминале:

```bash
curl -fsS http://127.0.0.1:19100/metrics | grep '^minutka_'
```

Firewall разрешает снаружи только SSH, а `node_exporter` привязан к loopback.
Метрики не содержат owner id, имён файлов, object keys или content.

## Операторские сигналы

| Ситуация | Метрика | Ожидание |
|---|---|---|
| Ассистент лежит | `minutka_systemd_unit_active{unit="minutka.service"}` | `0` |
| Smoke давно не проходил | `time() - minutka_smoke_last_success_timestamp_seconds` | больше 20–30 минут требует проверки |
| Бэкап не делался больше суток | `time() - minutka_backup_last_success_timestamp_seconds` | больше `86400` секунд требует проверки |
| Плановые касания перестали успешно выполняться | `time() - minutka_schedule_fire_last_success_timestamp_seconds` | сравнить с ожидаемым расписанием пилота |
| MinIO приближается к reserve | `minutka_minio_capacity_soft_threshold_exceeded` | `1` означает, что использован budget до filesystem reserve |
| Свободное место MinIO | `minutka_minio_filesystem_free_bytes` | должно оставаться выше reserve из `site.nix` |
| Artifact budget | `minutka_artifact_unique_cas_bytes` | должен оставаться ниже `minutka_artifact_global_hard_quota_bytes` |
| Owner soft quota | `minutka_artifact_owner_soft_quota_exceeded_count` | больше `0` — предупредить оператора до hard reject |
| Отказы новых файлов | `minutka_artifact_save_rejections_total{reason=...}` | причины: `object_limit`, `owner_quota`, `global_capacity` |
| Месячный расход | `minutka_usage_monthly_estimated_cost_usd` | агрегат по пилоту без owner labels |

`artifact_save_rejections_total` считается по retained journald за последние 30
дней и потому является operational gauge, а не вечным монотонным counter.
Основная цель — различать причины отказа без публикации пользовательских данных.

## Проверка отказов и деградации

Падение app должно ломать smoke:

```bash
sudo systemctl stop minutka.service
sudo systemctl start minutka-smoke.service || true
sudo systemctl status minutka-smoke.service
sudo journalctl -u minutka-smoke.service -n 50 --no-pager
sudo systemctl start minutka.service
sudo systemctl start minutka-smoke.service
```

Для проверки soft storage threshold на тестовом host временно уменьши
`site.storage.minio.capacityBytes` так, чтобы
`capacityBytes - filesystemReserveBytes` стало меньше текущего used bytes,
выполни dry activation/deploy и запусти collector. Метрика
`minutka_minio_capacity_soft_threshold_exceeded` должна стать `1` до
того, как hard filesystem reserve будет исчерпан. После проверки верни production
budget; не заполняй durable volume искусственными файлами.

Hard artifact capacity отклоняет только новые files. После такого отказа
проверь, что существующий chat/read path и smoke остаются зелёными:

```bash
sudo systemctl start minutka-smoke.service
curl -fsS http://127.0.0.1:8787/healthz
```

## Диагностика

```bash
sudo systemctl status minutka-smoke.service
sudo systemctl status minutka-observability-collector.service
sudo journalctl -u minutka-smoke.service -n 100 --no-pager
sudo journalctl -u minutka-observability-collector.service -n 100 --no-pager
sudo cat /var/lib/node-exporter-textfile/minutka.prom
sudo ss -lntp | grep '127.0.0.1:9100'
```

Если timestamp равен `0`, соответствующая успешная операция ещё не выполнялась
или state-файл отсутствует. Collector пишет временный файл и делает `mv`, поэтому
`node_exporter` не читает частично сформированный набор метрик.

## Алертинг оператору

Systemd-таймер `minutka-alerting.timer` каждые 10 минут запускает oneshot-сервис
`minutka-alerting.service`, который читает textfile-набор
`/var/lib/node-exporter-textfile/minutka.prom`, сравнивает пороги и отправляет
уведомление оператору в Telegram при нарушении.

### Проверяемые сигналы и пороги

| Сигнал | Метрика / условие | Порог |
|---|---|---|
| `unit_down` | `minutka_systemd_unit_active{unit="minutka.service"} == 0` | — |
| `smoke_stale` | `time() - minutka_smoke_last_success_timestamp_seconds` | > 30 мин |
| `smoke_never` | `minutka_smoke_last_success_timestamp_seconds == 0` | — |
| `backup_stale` | `time() - minutka_backup_last_success_timestamp_seconds` | > 86 400 с |
| `minio_capacity` | `minutka_minio_capacity_soft_threshold_exceeded == 1` | — |
| `artifact_owner_quota` | `minutka_artifact_owner_soft_quota_exceeded_count > 0` | — |

### Anti-flap

Для каждого сигнала ведётся файл
`/var/lib/minutka-alerting/<signal>.last_alert` с unix-timestamp последней
отправки. Повторное уведомление по тому же сигналу подавляется в пределах
4-часового окна.

### Канал доставки

Уведомление идёт через **отдельный бот-токен** (`ops_telegram_bot_token`) в
личный чат оператора (`ops_telegram_chat_id`). Оба значения хранятся в
[sops bundle](../../nixos/phase3-assistant-stack/secrets/minutka.yaml) и
расшифровываются sops-nix в `/run/secrets/minutka/`. Продуктовый бот-токен
(`TELEGRAM_BOT_TOKEN`) для алертинга не используется; контур рассылок
участникам не задет.

Для создания операторского бота:

1. Создай нового бота через `@BotFather`, получи токен.
2. Узнай numeric chat id оператора (например, через `@userinfobot`).
3. Добавь оба значения в sops bundle:

   ```bash
   SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt sops secrets/minutka.yaml
   ```

4. Разверни (`./scripts/deploy.sh`) — таймер начнёт проверки автоматически.

### Быстрая проверка

```bash
sudo systemctl status minutka-alerting.timer
sudo systemctl list-timers minutka-alerting.timer
sudo systemctl start minutka-alerting.service
sudo journalctl -u minutka-alerting.service --since today
ls -la /var/lib/minutka-alerting/
```

### Проверка алерта остановкой сервиса

```bash
sudo systemctl stop minutka.service
sudo systemctl start minutka-observability-collector.service
sudo systemctl start minutka-alerting.service
sudo journalctl -u minutka-alerting.service -n 20 --no-pager
# Ожидание: Telegram-уведомление «minutka.service is not active»
sudo systemctl start minutka.service
```

Текст уведомления не содержит owner id, имён или content — только название
сигнала и метрику.
