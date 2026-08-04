# NixOS production host

Базовая конфигурация нового VPS для пилота personal-assistant. Она повторяет
проверенную двухфазную схему из `matrix-server-nixos`, но не переносит Matrix
stack, Caddy, ACME или coturn. Снаружи открыт только SSH; Telegram использует
polling, а HTTP API приложения должен оставаться на loopback.

## Каталоги

- `phase1-installable-base/` — минимальная установка с `disko` и
  `nixos-anywhere`;
- `phase2-ops-base/` — admin-пользователь, sudo, ops-пакеты, zram, firewall,
  fail2ban и deploy через `deploy-rs`.

Обе фазы используют `github:NixOS/nixpkgs/nixos-25.11` и конфигурацию
`personal-assistant-1`.

## 1. Заполнить параметры площадки

Перед любым запуском отредактируй **оба** `site.nix` и держи общие параметры
синхронизированными:

- `system`, `hostName`, `timeZone`, `bootMode`, `disk`;
- `publicIPv4` и `deploy.sshHost`/`sshTarget`;
- `deploy.sshIdentityFile` — локальный приватный ключ для подключения;
- `rootAuthorizedKeys` в Phase 1 и тот же ключ в `adminAuthorizedKeys` Phase 2;
- сетевой режим и параметры.

По умолчанию `network.useDHCP = true`. Для статической сети переключи его в
`false` и заполни `interface`, `address`, `prefixLength`, `gateway` и
`nameservers` значениями провайдера. Плейсхолдеры `REPLACE_ME` намеренно
ломают evaluation там, где параметр уже должен быть реальным; это защищает от
установки без ключа или адреса deploy target.

Phase 1 входит как `root`, потому что rescue-окружение VPS обычно предоставляет
именно root SSH. После Phase 2 root login запрещён и дальнейшие deploy идут как
`admin`.

## 2. Проверить Phase 1 в VM

Из каталога `nixos/phase1-installable-base`:

```bash
./scripts/install-vm-test.sh
```

Скрипт сохраняет лог в `./logs/`. Параметры:

```bash
LOG_DIR=/tmp/personal-assistant-install-logs ./scripts/install-vm-test.sh
NIXOS_ANYWHERE_FLAKE=github:nix-community/nixos-anywhere ./scripts/install-vm-test.sh
```

## 3. Установить новый VPS

Включи у провайдера rescue system, добавь туда SSH-ключ и проверь, что
`site.nix` указывает на правильный диск. Затем из
`nixos/phase1-installable-base`:

```bash
./scripts/install-server.sh
```

Это **размечает указанный диск и уничтожает его прежнее содержимое**. Скрипт
запускает `nixos-anywhere` с `disko`, генерирует
`hosts/personal-assistant-1/hardware-configuration.nix` и пишет полный лог в
`./logs/`.

Поддерживаемые параметры:

```bash
BUILD_ON=remote ./scripts/install-server.sh        # default
BUILD_ON=local ./scripts/install-server.sh
NO_DISKO_DEPS=1 ./scripts/install-server.sh
NIXOS_ANYWHERE_FLAKE=github:nix-community/nixos-anywhere ./scripts/install-server.sh
LOG_DIR=/tmp/personal-assistant-install-logs ./scripts/install-server.sh
```

После reboot проверь вход root только по ключу:

```bash
ssh -i /path/to/id_ed25519 root@SERVER_IP
```

## 4. Применить ops baseline через deploy-rs

Скопируй сгенерированную hardware-конфигурацию в Phase 2:

```bash
cp \
  nixos/phase1-installable-base/hosts/personal-assistant-1/hardware-configuration.nix \
  nixos/phase2-ops-base/hosts/personal-assistant-1/hardware-configuration.nix
```

Закоммить этот файл вместе с реальными параметрами площадки. Затем из
`nixos/phase2-ops-base`:

```bash
./scripts/deploy.sh
```

Дополнительные аргументы передаются `deploy-rs`, например:

```bash
./scripts/deploy.sh --dry-activate
./scripts/deploy.sh --skip-checks
```

Если deploy-rs недоступен в конкретном окружении, оставлены fallback-скрипты:

```bash
./scripts/rebuild-linux.sh
./scripts/rebuild-macos.sh
```

После Phase 2 вход выполняется как `admin`; password и keyboard-interactive
login отключены, root login запрещён, TCP forwarding разрешён только локальный
(для будущего SSH-туннеля к метрикам), работает fail2ban.

## 5. Проверить firewall и откат

С внешней машины:

```bash
nmap -Pn SERVER_IP
```

Ожидаемый результат — доступен только `22/tcp`. На хосте можно дополнительно
проверить:

```bash
sudo nft list ruleset
sudo ss -lntup
```

Откат к предыдущему NixOS generation:

```bash
cd nixos/phase2-ops-base
./scripts/rollback.sh
```

Эквивалентная команда на самом сервере:

```bash
sudo nixos-rebuild switch --rollback
```

После deploy и после rollback повторно проверь SSH-доступ, активность
`sshd`/`fail2ban` и внешний `nmap`.
