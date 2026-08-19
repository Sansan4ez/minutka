# Phase 1: installable base

Минимальная первая установка NixOS на VPS minutka. Phase 1 должна
оставаться лёгкой, чтобы `nixos-anywhere` не тащил лишний closure.

Содержит `disko`, boot/network/SSH модули, host bootstrap и install scripts с
логированием в `./logs/`. Bootstrap также декларативно создаёт admin-пользователя
с тем же SSH-ключом и passwordless `sudo`, чтобы первый Phase 2 deploy сразу мог
подключаться как `admin`; root SSH остаётся доступен до активации Phase 2.
`install-server.sh` устанавливает заранее сгенерированный production host key из
`~/.config/minutka/production/ssh_host_ed25519_key`, чтобы recipient sops bundle
не изменился после destructive install.

Перед использованием заполни `site.nix`. Полный порядок установки и параметры
скриптов описаны в [`../README.md`](../README.md).

```bash
./scripts/install-vm-test.sh
./scripts/install-server.sh
```

Ключевые параметры:

```bash
BUILD_ON=remote ./scripts/install-server.sh
NO_DISKO_DEPS=1 ./scripts/install-server.sh
NIXOS_ANYWHERE_FLAKE=github:nix-community/nixos-anywhere ./scripts/install-server.sh
LOG_DIR=/tmp/minutka-install-logs ./scripts/install-server.sh
HOST_KEY_FILE=/secure/path/ssh_host_ed25519_key ./scripts/install-server.sh
```
