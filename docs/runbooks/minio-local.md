# Локальный MinIO

> **Унаследовано от персонального ассистента.** Команды и стек служат операционным фундаментом клона; хосты, unit names и пути должны быть перенастроены под «Минутку». Живые продуктовые и privacy-решения: [RFC «Минутки»](../architecture/rfc-minutka-tenancy-and-reporting.md).


MinIO хранит owner-scoped документы, временные ingress blobs и содержимое артефактов. После KB cutover MinIO — единственный source of truth базы знаний; Git workspace используется только для контролируемого bootstrap import и не синхронизируется двусторонне. `compose.yaml` публикует S3 API и Console только на `127.0.0.1`, поэтому персональные данные не доступны напрямую из внешней сети.

## Настройка окружения

Создать локальный `.env`, если его ещё нет:

```bash
cp .env.example .env
chmod 600 .env
```

Задать четыре разных секрета и bucket:

```dotenv
MINIO_ROOT_USER=minio-admin-local
MINIO_ROOT_PASSWORD=<strong-random-root-password>
MINIO_ACCESS_KEY=personal-assistant-app
MINIO_SECRET_KEY=<strong-random-application-secret>
MINIO_BUCKET=minutka

MINIO_ENDPOINT=127.0.0.1
MINIO_PORT=9002
MINIO_USE_SSL=false
```

Сгенерировать пароли можно так:

```bash
openssl rand -hex 32
```

`MINIO_ROOT_USER` и `MINIO_ROOT_PASSWORD` используются только для администрирования и входа в Console. Приложение использует отдельные `MINIO_ACCESS_KEY` и `MINIO_SECRET_KEY`; root credentials не передавать runtime ассистента и не коммитить.

## Запуск контейнеров

Запустить сервер и одноразовую инициализацию:

```bash
docker compose up -d minio minio-init
```

`minio-init` ждёт готовности MinIO, после чего:

- создаёт bucket из `MINIO_BUCKET`;
- включает bucket versioning;
- создаёт least-privilege application user;
- привязывает policy для чтения, записи, удаления и листинга объектов.

После успешной инициализации контейнер `minio-init` завершается с кодом `0`. Это ожидаемое поведение, а не падение сервиса.

Проверить состояние:

```bash
docker compose ps -a minio minio-init
docker compose logs --tail=100 minio minio-init
curl -fsS http://127.0.0.1:9002/minio/health/ready
```

Ожидаемый результат:

- `minio` — `running`/`healthy`;
- `minio-init` — `exited (0)`;
- health endpoint отвечает без ошибки.

Если Docker требует повышенных прав, использовать те же команды через `sudo docker compose ...`.

## MinIO Console

Открыть в браузере:

```text
http://127.0.0.1:9003
```

Для входа использовать:

- username: значение `MINIO_ROOT_USER` из локального `.env`;
- password: значение `MINIO_ROOT_PASSWORD` из локального `.env`.

Не использовать `MINIO_ACCESS_KEY` для административного входа: это ограниченная application credential.

После входа открыть **Object Browser** → bucket `personal-assistant`. Канонические durable owner-scoped зоны:

```text
<owner-id>/context/*
<owner-id>/cas/sha256/**
```

Для документов pilot knowledge base MinIO является единственным source of truth после bootstrap import; канонический prefix:

```text
<PILOT_USER_ID>/context/
```

`<owner-id>/inbox/*` не provisionится как отдельный namespace и не является
действующим knowledge-base path. Runtime может создавать внутренние временные
blob keys для ingress, но canonical artifact content хранится как CAS под
`<owner-id>/cas/sha256/**`.

Legacy prefix `<PILOT_USER_ID>/context/imported-knowledge-base/` может временно оставаться во время compatibility migration, но не используется новыми импортами и не показывается агенту.

Versioning можно проверить в настройках bucket или в списке версий конкретного объекта.

### Console на удалённом сервере

Порты намеренно привязаны к loopback-интерфейсу. Не менять binding на `0.0.0.0`. Для доступа с рабочей машины открыть SSH tunnel:

```bash
ssh -L 9001:127.0.0.1:9001 -L 9000:127.0.0.1:9000 <user>@<server>
```

Пока SSH-сессия открыта, Console доступна локально по `http://127.0.0.1:9001`.

## Контрактная проверка

Smoke-тест проверяет bucket versioning, owner isolation, документы, blobs, артефакты и presigned URLs:

```bash
MINIO_SMOKE=true npm run specs:minio
```

Тест загружает `.env`, создаёт временные owner-scoped объекты и удаляет их после выполнения. Не направлять его на чужой или production bucket без явного разрешения.

## Остановка и повторный запуск

Остановить MinIO без удаления данных:

```bash
docker compose stop minio
```

Запустить снова и повторно безопасно проверить provisioning:

```bash
docker compose up -d minio minio-init
```

Данные сохраняются в named volume `minutka-minio-data`.

## Полный сброс локального MinIO

> Внимание: операция необратимо удаляет все локальные MinIO objects и версии. Она не должна выполняться для pilot/production данных.

Не использовать `docker compose down --volumes` только ради MinIO: эта команда может также удалить PostgreSQL volume проекта. Для изолированного сброса:

```bash
docker compose stop minio
docker compose rm -f minio minio-init
docker volume rm minutka-minio-data
docker compose up -d minio minio-init
```

Перед удалением volume проверить его имя:

```bash
docker volume ls | grep minutka-minio-data
```

## Диагностика

### `MINIO_ROOT_USER` или другой параметр не задан

Compose читает `.env` из корня репозитория. Проверить наличие непустых значений, не печатая секреты в общие логи:

```bash
test -s .env && echo '.env exists'
docker compose config --services
```

### `minio-init` завершился с ошибкой

Посмотреть его лог:

```bash
docker compose logs minio-init
```

После исправления `.env` повторить:

```bash
docker compose up -d minio minio-init
```

### Console не открывается

Проверить container health и локальный port binding:

```bash
docker compose ps minio
curl -fsS http://127.0.0.1:9002/minio/health/ready
```

Локально S3 API опубликован на порту `9002`, веб-Console — на `9003`: они сдвинуты с ассистентских `9000`/`9001`, чтобы оба стека работали одновременно. Внутри контейнера и на удалённом хосте порты остаются `9000`/`9001` — для него нужен SSH tunnel из раздела выше.
