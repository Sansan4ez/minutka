# NixOS production host

Базовая конфигурация нового VPS для пилота personal-assistant. Она повторяет
проверенную двухфазную схему из `matrix-server-nixos`, но не переносит Matrix
stack, Caddy, ACME или coturn. Снаружи открыт только SSH; Telegram использует
polling, а HTTP API приложения должен оставаться на loopback.

## Каталоги

- `phase1-installable-base/` — минимальная установка с `disko` и
  `nixos-anywhere`;
- `phase2-ops-base/` — admin-пользователь, sudo, ops-пакеты, zram, firewall,
  fail2ban и deploy через `deploy-rs`;
- `phase3-assistant-stack/` — production stack с `sops-nix`, приложением,
  PostgreSQL 16 и loopback-only MinIO с декларативным provisioning.

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

Phase 1 входит в rescue как `root`, но устанавливаемая bootstrap-конфигурация
сразу декларативно создаёт `admin` с тем же ключом и passwordless `sudo`. Поэтому
первый Phase 2 deploy уже выполняется обычной командой как `admin`. После Phase 2
root login запрещён, дальнейшие deploy также идут как `admin`.

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

После reboot проверь входы по ключу: `root` остаётся аварийным доступом до
Phase 2, а `admin` уже готов для первого Phase 2 deploy:

```bash
ssh -i /path/to/id_ed25519 root@SERVER_IP
ssh -i /path/to/id_ed25519 admin@SERVER_IP
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

Phase 2 предполагает, что актуальная Phase 1 уже применена и `admin` доступен по
SSH. Если Phase 1 менялась после установки, сначала повторно примени её через
`nixos/phase1-installable-base/scripts/rebuild-linux.sh`, а затем запускай Phase 2.

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

## 6. Подготовить production secrets

Phase 3 использует зашифрованный bundle и не копирует `.env` на сервер.
Инициализация recipients и bundle описана в
[`phase3-assistant-stack/secrets/README.md`](phase3-assistant-stack/secrets/README.md),
ротация и восстановление — в
[`../docs/runbooks/production-secrets.md`](../docs/runbooks/production-secrets.md).
После подготовки проверь durable MinIO volume и capacity budget в
`phase3-assistant-stack/site.nix`, подготовь Git source knowledge base и ключ
`backupPull`, затем примени stack через
`nixos/phase3-assistant-stack/scripts/deploy.sh`. Подробный storage contract,
проверки ролей/bucket/versioning и канонические prefixes описаны в
[`phase3-assistant-stack/README.md`](phase3-assistant-stack/README.md), backup,
off-site pull и восстановление с нуля — в
[`../docs/runbooks/production-backup-restore.md`](../docs/runbooks/production-backup-restore.md),
а smoke, loopback-метрики и SSH-туннель — в
[`../docs/runbooks/production-observability.md`](../docs/runbooks/production-observability.md).
