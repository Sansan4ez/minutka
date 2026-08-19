# Production secrets: sops-nix

> Стек унаследован от персонального ассистента и адаптирован под отдельный production-контур «Минутки»: собственный хост, unit names, storage paths и secrets bundle. Живые продуктовые и privacy-решения: [RFC «Минутки»](../architecture/rfc-minutka-tenancy-and-reporting.md).


## Назначение

Production-секреты хранятся только в зашифрованном
[`nixos/phase3-assistant-stack/secrets/minutka.yaml`](../../nixos/phase3-assistant-stack/secrets/minutka.yaml).
Владелец редактирует bundle локальным age-ключом; production-хост расшифровывает
его своим `ssh-ed25519` host private key. Расшифрованные значения из sops bundle
существуют только в tmpfs: sops-nix-файлы и шаблоны — под `/run/secrets*`, а
writable runtime-копия конфига CLIProxyAPI — `/run/cliproxyapi/config.yaml` с
mode `0600` и владельцем
`cliproxyapi:cliproxyapi`.

Конфиг CLIProxyAPI декларативен: источник истины — шаблон `cliproxyConfig` в
[`modules/minutka-secrets.nix`](../../nixos/phase3-assistant-stack/modules/minutka-secrets.nix).
При каждом старте сервиса он заново копируется в tmpfs, поэтому изменения через
панель управления не переживают restart или deploy по замыслу. OAuth-креды,
полученные CLIProxyAPI вне sops bundle, хранятся отдельно в
`/var/lib/cliproxyapi/.cli-proxy-api` и остаются durable. При первом старте после
выкатки сервис сам удаляет legacy-копию конфига. Проверь результат; если сервис
ещё не запускался, удали файл вручную:

```bash
sudo rm -f /var/lib/cliproxyapi/config.yaml
```

## Обычное изменение или ротация секрета

1. Сохрани резервную копию durable-данных, если меняется credential хранилища.
2. Из `nixos/phase3-assistant-stack` открой bundle:

   ```bash
   SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt sops secrets/minutka.yaml
   ```

3. Измени только нужное значение. Не ротируй вместе независимые credentials.
4. Проверь файл без расшифровки в stdout:

   ```bash
   sops filestatus secrets/minutka.yaml
   ! grep -Eq 'change-me|REPLACE_ME' secrets/minutka.yaml
   git diff -- secrets/minutka.yaml
   ```

5. Выполни `./scripts/deploy.sh --dry-activate`, затем обычный deploy.
6. Перезапусти consumer, если его модуль ещё не подписан на изменение sops
   template. После смены `minio_secret_key` сначала перезапусти
   `minutka-minio-provision`, чтобы применить credential
   в MinIO, затем перезапусти приложение:

   ```bash
   sudo systemctl restart minutka-minio-provision
   sudo systemctl restart minutka
   ```

   Проверь readiness и хранение/чтение объекта без печати значения секрета.
7. После подтверждения отзови прежний credential у провайдера.

`INTEGRATION_ENC_KEY`, `INVITE_CODE_PEPPER` и `TELEGRAM_IDENTITY_PEPPER` нельзя
ротировать как обычный token внутри контура с существующими durable-данными:

- смена `INTEGRATION_ENC_KEY` требует предварительно перечитать и
  перешифровать все integration credentials/chat ids;
- смена pepper требует migration, которая пересчитает соответствующие digests
  из доступного исходного идентификатора;
- при restore/data migration значения сохраняются byte-for-byte, если отдельной
  migration нет.

Это ограничение не означает, что чистый production обязан наследовать dev
secrets. При clean bootstrap с новой PostgreSQL и пустым MinIO старых
ciphertext/digests нет, поэтому эти три значения генерируются заново как
production-only. Не копируй dev `.env` целиком. Переиспользуй только явно
выбранные внешние credentials; при Telegram cutover — текущий bot token после
остановки dev polling. Пошаговая последовательность описана в
[runbook чистого production cutover](./production-clean-cutover.md).

## Ротация локального age-ключа владельца

1. Создай новый ключ и надёжно сохрани его private backup.
2. Добавь новый owner recipient в `.sops.yaml`, не удаляя старый.
3. Пока старый ключ доступен, обнови recipients:

   ```bash
   SOPS_AGE_KEY_FILE=/path/to/old-keys.txt sops updatekeys secrets/minutka.yaml
   ```

4. Проверь decrypt новым ключом.
5. Удали старый recipient из `.sops.yaml`, повтори `sops updatekeys` уже новым
   ключом и снова проверь decrypt. Только затем уничтожай старый private key.

## Перевыпуск после замены SSH host key

Смена `/etc/ssh/ssh_host_ed25519_key` меняет server recipient. До удаления
старого host private key:

1. Получи и сверяй новый public key по доверенному каналу.
2. Рассчитай recipient: `ssh-keyscan -t ed25519 SERVER_IP | ssh-to-age`.
3. Добавь новый server recipient в `.sops.yaml`, пока старый host key ещё
   доступен.
4. Выполни `sops updatekeys secrets/minutka.yaml` ключом владельца.
5. Сделай dry activation и deploy.
6. На хосте проверь успешный `sops-nix.service` и наличие runtime-файлов.
7. Удали старый recipient из `.sops.yaml`, повтори `sops updatekeys` и deploy.
8. Только после второго успешного deploy удаляй старый host private key/старое
   поколение.

Если старый host key уже потерян, bundle остаётся восстанавливаемым локальным
owner age key. Если потеряны оба private key, ciphertext восстановить нельзя —
нужны перевыпуск всех внешних credentials и отдельная data migration для
стабильных ключей/peppers.

## Проверка отсутствия plaintext

Команды не должны печатать значения:

```bash
# Репозиторий не содержит production .env.
git ls-files '.env' '.env_*' '.env.bak*'

# На хосте plaintext-конфиги и secret files существуют только в runtime tmpfs.
sudo find /run/secrets /run/cliproxyapi \
  -type f -printf '%m %U:%G %p\n'
sudo find /var/lib/minutka /var/lib/cliproxyapi /opt /srv \
  -xdev -type f \( -name '.env' -o -name '*secret*' -o -name 'config.yaml' \) -print
```

Ожидание: первая команда ничего не выводит; application runtime-файлы имеют
`0400 minutka:minutka`, PostgreSQL role passwords и MinIO
app credential — `0440 minutka:postgres` для peer-authenticated
setup/restore smoke, MinIO root
template — `0400 minio:minio`, CLIProxyAPI runtime config —
`0600 cliproxyapi:cliproxyapi`; последний поиск не находит production secret
copies.
