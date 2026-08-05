# Production secrets: sops-nix

## Назначение

Production-секреты хранятся только в зашифрованном
[`nixos/phase3-assistant-stack/secrets/assistant.yaml`](../../nixos/phase3-assistant-stack/secrets/assistant.yaml).
Владелец редактирует bundle локальным age-ключом; production-хост расшифровывает
его своим `ssh-ed25519` host private key. Plaintext на сервере существует только
в tmpfs-путях `/run/secrets*` с mode `0400`.

## Обычное изменение или ротация секрета

1. Сохрани резервную копию durable-данных, если меняется credential хранилища.
2. Из `nixos/phase3-assistant-stack` открой bundle:

   ```bash
   SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt sops secrets/assistant.yaml
   ```

3. Измени только нужное значение. Не ротируй вместе независимые credentials.
4. Проверь файл без расшифровки в stdout:

   ```bash
   sops filestatus secrets/assistant.yaml
   ! grep -Eq 'change-me|REPLACE_ME' secrets/assistant.yaml
   git diff -- secrets/assistant.yaml
   ```

5. Выполни `./scripts/deploy.sh --dry-activate`, затем обычный deploy.
6. Перезапусти consumer, если его модуль ещё не подписан на изменение sops
   template, и проверь readiness без печати значения секрета.
7. После подтверждения отзови прежний credential у провайдера.

`INTEGRATION_ENC_KEY`, `INVITE_CODE_PEPPER` и `TELEGRAM_IDENTITY_PEPPER` нельзя
ротировать как обычный token:

- смена `INTEGRATION_ENC_KEY` требует предварительно перечитать и
  перешифровать все integration credentials/chat ids;
- смена pepper требует migration, которая пересчитает соответствующие digests
  из доступного исходного идентификатора;
- если такой migration нет, значения сохраняются byte-for-byte при переносе.

## Ротация локального age-ключа владельца

1. Создай новый ключ и надёжно сохрани его private backup.
2. Добавь новый owner recipient в `.sops.yaml`, не удаляя старый.
3. Пока старый ключ доступен, обнови recipients:

   ```bash
   SOPS_AGE_KEY_FILE=/path/to/old-keys.txt sops updatekeys secrets/assistant.yaml
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
4. Выполни `sops updatekeys secrets/assistant.yaml` ключом владельца.
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

# На хосте secret files существуют только в runtime tmpfs.
sudo find /run/secrets \
  -type f -printf '%m %U:%G %p\n'
sudo find /var/lib/personal-assistant /opt /srv \
  -xdev -type f \( -name '.env' -o -name '*secret*' \) -print
```

Ожидание: первая команда ничего не выводит; application runtime-файлы имеют
`0400 personal-assistant:personal-assistant`, PostgreSQL role passwords и MinIO
app credential — `0440 personal-assistant:postgres` для peer-authenticated
setup/restore smoke, MinIO root
template — `0400 minio:minio`; последний поиск не находит production secret
copies.
