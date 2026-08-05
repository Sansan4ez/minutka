# Phase 3: production assistant stack

Третий этап добавляет к operational baseline `sops-nix`, Nix-пакет приложения
и systemd-сервис ассистента. PostgreSQL и MinIO подключаются отдельным модулем
INF.3; сервис уже декларативно требует оба юнита и стартует после них.

## Что обеспечивает этап

- единственный зашифрованный bundle `secrets/assistant.yaml` в git;
- расшифровка хостовым `/etc/ssh/ssh_host_ed25519_key` без отдельного server age key;
- runtime-файлы только в `/run/secrets*`, owner `personal-assistant`, mode `0400`;
- systemd-совместимый `/run/secrets/rendered/personal-assistant.env` без кавычек
  и комментариев;
- evaluation failure при отсутствующем, незашифрованном bundle или видимом
  плейсхолдере;
- `pkgs.buildNpmPackage` с pinned `npmDepsHash`, без отдельного build-step;
- self-contained runtime в `/nix/store/.../lib/personal-assistant` с
  `package.json`, `node_modules`, `src`, `vault/assistant` и `migrations`;
- system user, restart через 5 секунд, journald и systemd hardening;
- reviewable non-secret runtime limits and token-price settings in the NixOS
  module; journal storage capped at 512 MiB.

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

Локально пакет можно собрать отдельно:

```bash
nix build .#personal-assistant
```

Проверка после deploy:

```bash
sudo find /run/secrets \
  -type f -printf '%m %U:%G %p\n'
sudo systemctl status personal-assistant
sudo systemctl show personal-assistant \
  -p EnvironmentFiles -p WorkingDirectory -p Restart -p RestartUSec
sudo journalctl -u personal-assistant --since today
```

Ожидаются только `0400 personal-assistant:personal-assistant`, а
`WorkingDirectory` должен указывать на пакет в Nix store. Для smoke restart:

```bash
pid="$(systemctl show -p MainPID --value personal-assistant)"
sudo kill -9 "$pid"
timeout 10 sh -c 'until systemctl is-active --quiet personal-assistant; do sleep 1; done'
```

Содержимое секретов в терминал и журналы не выводится. Версия приложения входит
в то же NixOS generation, поэтому `./scripts/rollback.sh` откатывает сервис и
хост вместе.
