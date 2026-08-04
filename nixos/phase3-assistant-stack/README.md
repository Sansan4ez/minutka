# Phase 3: production secrets baseline

Третий этап добавляет `sops-nix` к operational baseline. Он не поднимает само
приложение, PostgreSQL или MinIO: соответствующие модули подключаются задачами
INF.2 и INF.3 к этому stack-каталогу.

## Что обеспечивает этап

- единственный зашифрованный bundle `secrets/assistant.yaml` в git;
- расшифровка хостовым `/etc/ssh/ssh_host_ed25519_key` без отдельного server age key;
- runtime-файлы только в `/run/secrets*`, owner `personal-assistant`, mode `0400`;
- systemd-совместимый `/run/secrets/rendered/personal-assistant.env` без кавычек
  и комментариев;
- evaluation failure при отсутствующем, незашифрованном bundle или видимом
  плейсхолдере.

Подготовка и проверка bundle описаны в
[`secrets/README.md`](secrets/README.md). Ротация и аварийное восстановление — в
[`../../docs/runbooks/production-secrets.md`](../../docs/runbooks/production-secrets.md).

## Deploy

Перед deploy на хосте уже должна быть применена Phase 2, а production
`ssh-ed25519` host key не должен меняться после шифрования bundle.

```bash
./scripts/deploy.sh --dry-activate
./scripts/deploy.sh
```

Проверка runtime-файлов:

```bash
sudo find /run/secrets \
  -type f -printf '%m %U:%G %p\n'
sudo systemctl show personal-assistant -p EnvironmentFiles
```

Ожидаются только `0400 personal-assistant:personal-assistant`. Содержимое
секретов в терминал и журналы не выводится.
