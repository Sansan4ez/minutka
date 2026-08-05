# Секреты production stack

`assistant.yaml` — единственный git-tracked secret bundle. Он зашифрован `sops`
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
5. Создай bundle и перенеси действующие значения из локального `.env`:

   ```bash
   cp secrets/assistant.yaml.example secrets/assistant.yaml
   sops secrets/assistant.yaml
   ```

   `INTEGRATION_ENC_KEY`, `INVITE_CODE_PEPPER` и
   `TELEGRAM_IDENTITY_PEPPER` переносятся без изменения. Их случайная
   регенерация разрывает существующие привязки и делает часть durable-данных
   нечитаемой.

6. Для production PostgreSQL URL используй unix socket, а не TCP:

   ```text
   postgresql://minutka_runtime:...@localhost/minutka?host=%2Frun%2Fpostgresql
   postgresql://minutka_migrator:...@localhost/minutka?host=%2Frun%2Fpostgresql
   ```

   `DATABASE_SSL_MODE=disable` задаётся NixOS-модулем: локальный unix socket не
   использует TLS и не доступен снаружи.

7. Проверь, что в файле нет plaintext и плейсхолдеров:

   ```bash
   sops filestatus secrets/assistant.yaml
   ! grep -Eq 'change-me|REPLACE_ME' secrets/assistant.yaml
   ```

Зашифрованный `assistant.yaml` коммитится. Открытый экспорт, расшифрованная копия
и production `.env` не создаются и не копируются на сервер.

## Runtime paths

`modules/assistant-secrets.nix` создаёт:

- `/run/secrets/assistant/*` — отдельные значения для PostgreSQL/MinIO bootstrap;
- `/run/secrets/rendered/personal-assistant.env` — чистый `KEY=value` для
  systemd `EnvironmentFile` приложения и migration oneshot;
- `/run/secrets/rendered/minio-root.env` — root credential file только для
  `minio.service`.

Application runtime получает только `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`; root
credential не входит в его EnvironmentFile. Все файлы имеют mode `0400` и
принадлежат минимально необходимому service user (`personal-assistant` либо
`minio`). В `/nix/store`, working directory и home сервисов plaintext не
попадает.
