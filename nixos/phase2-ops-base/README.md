# Phase 2: operational baseline

Второй этап после первой установки NixOS. Он добавляет admin-пользователя,
passwordless wheel sudo с `execWheelOnly`, ops packages, zram, fail2ban и
firewall с открытым только `22/tcp`.

Перед deploy:

1. Заполни `site.nix` теми же host/network параметрами, что в Phase 1.
2. Укажи `adminAuthorizedKeys` и `deploy.sshUser = "admin"`.
3. Скопируй сгенерированный Phase 1 файл:

```bash
cp \
  ../phase1-installable-base/hosts/personal-assistant-1/hardware-configuration.nix \
  ./hosts/personal-assistant-1/hardware-configuration.nix
```

4. Примени baseline через deploy-rs:

```bash
./scripts/deploy.sh
```

Fallback для прямого `nixos-rebuild`:

```bash
./scripts/rebuild-linux.sh
# или на macOS:
./scripts/rebuild-macos.sh
```

Полная процедура, параметры и проверки описаны в
[`../README.md`](../README.md).
