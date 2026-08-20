# Секреты production stack

`minutka.yaml` — единственный git-tracked secret bundle. Он зашифрован `sops`
для двух получателей: локального age-ключа владельца и `ssh-ed25519` host key
production-сервера. На хосте `sops-nix` расшифровывает bundle через
`/etc/ssh/ssh_host_ed25519_key`; отдельный age private key на сервер не копируется.

## Первичное создание

1. Установи `sops`, `age` и `ssh-to-age`.
2. Создай локальный ключ, если его ещё нет:

   ```bash
   mkdir -p ~/.config/sops/age
   age-keygen -o ~/.config/sops/age/keys.txt
   age-keygen -y ~/.config/sops/age/keys.txt
   ```

3. Получи recipient неизменяемого production host key:

   ```bash
   ssh-keyscan -t ed25519 SERVER_IP | ssh-to-age
   ```

   Сверь fingerprint ключа по доверенному каналу перед использованием.

4. Запиши оба recipient в `../.sops.yaml`. Owner recipient не является
   секретом; private key остаётся вне репозитория и должен иметь отдельный backup.
5. Создай bundle и заполни production values:

   ```bash
   cp secrets/minutka.yaml.example secrets/minutka.yaml
   sops secrets/minutka.yaml
   ```

   Выбор значений зависит от режима запуска:

   - при restore/migration существующей PostgreSQL сохраняй
     `INTEGRATION_ENC_KEY`, `INVITE_CODE_PEPPER` и `TELEGRAM_IDENTITY_PEPPER`
     byte-for-byte: их регенерация разрывает существующие привязки и делает
     ciphertext/digests нечитаемыми;
   - при clean production bootstrap без старых PostgreSQL/MinIO данных создай
     новые независимые production-only значения; dev `.env` целиком не копируй;
   - внешний credential переиспользуй только явно. Для controlled Telegram
     cutover это текущий `TELEGRAM_BOT_TOKEN`, причём polling сначала должен
     быть остановлен на dev;
   - `openai_api_key` в bundle — отдельный production client key для локального
     CLIProxyAPI, а не provider credential и не значение из dev `.env`. Provider
     OAuth/API credentials добавляются после Phase 3 через SSH tunnel.

6. Для production PostgreSQL URL используй unix socket, а не TCP:

   ```text
   postgresql://minutka_runtime:...@localhost/minutka?host=%2Frun%2Fpostgresql
   postgresql://minutka_migrator:...@localhost/minutka?host=%2Frun%2Fpostgresql
   ```

   `DATABASE_SSL_MODE=disable` задаётся NixOS-модулем: локальный unix socket не
   использует TLS и не доступен снаружи.

7. Проверь, что в файле нет plaintext и плейсхолдеров:

   ```bash
   sops filestatus secrets/minutka.yaml
   ! grep -Eq 'change-me|REPLACE_ME' secrets/minutka.yaml
   ```

Зашифрованный `minutka.yaml` коммитится. Открытый экспорт, расшифрованная копия
и production `.env` не создаются и не копируются на сервер.

## Runtime paths

`modules/minutka-secrets.nix` создаёт:

- `/run/secrets/minutka/*` — отдельные значения для PostgreSQL/MinIO bootstrap;
- `/run/secrets/rendered/minutka.env` — чистый `KEY=value` для
  systemd `EnvironmentFile` приложения и migration oneshot;
- `/run/secrets/rendered/minio-root.env` — root credential file только для
  `minio.service`.
- `/run/secrets/minutka/ops_telegram_bot_token`,
  `/run/secrets/minutka/ops_telegram_chat_id` — операторский алертинг (отдельный
  бот, не продуктовый).

Application runtime получает только `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`; root
credential не входит в его EnvironmentFile. `cliproxy_management_key` рендерится
только в `/run/secrets/rendered/cliproxyapi.yaml`: CLIProxyAPI использует его для
loopback management API, а приложение получает отдельный client key через
`OPENAI_API_KEY`. Все файлы имеют mode `0400` и принадлежат минимально
необходимому service user (`minutka`, `cliproxyapi` либо `minio`). В
`/nix/store`, working directory и home сервисов plaintext не попадает.

## CLIProxyAPI credentials

Production CLIProxyAPI хранит OAuth/provider credentials в persistent каталоге
`/var/lib/cliproxyapi/.cli-proxy-api/`. Это аналог `~/.cli-proxy-api/` на dev:
HOME service user равен `/var/lib/cliproxyapi`, поэтому credentials, добавленные
через CLI или management panel, автоматически сохраняются там и переживают
restart/deploy. Они намеренно не копируются с dev и не коммитятся в этот repo.

Management panel доступна только через SSH tunnel:

```bash
ssh -L 8317:127.0.0.1:8317 admin@169.58.201.159
```

После этого открыть `http://127.0.0.1:8317/management.html`. Management key
хранится в sops bundle; его значение не печатать в logs/issue. До добавления
хотя бы одного provider credential `/v1/models` может быть пустым, а запросы
ассистента к LLM будут завершаться ошибкой.
