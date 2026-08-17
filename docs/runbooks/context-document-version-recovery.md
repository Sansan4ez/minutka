# Восстановление удалённой версии контекстного документа

> **Унаследовано от персонального ассистента.** Команды и стек служат операционным фундаментом клона; хосты, unit names и пути должны быть перенастроены под «Минутку». Живые продуктовые и privacy-решения: [RFC «Минутки»](../architecture/rfc-minutka-tenancy-and-reporting.md).


Этот runbook описывает operator-процедуру для случая, когда владелец подтвердил удаление не того документа. Процедура работает через typed HTTP use-cases и CLI: оператор не обращается к PostgreSQL, MinIO object key или консоли MinIO.

## Предварительные условия

- общий runtime запущен;
- MinIO bucket использует versioning;
- у оператора есть `MINUTKA_ADMIN_TOKEN`;
- известны employee ID и transport-handle документа в форме `/proc/context/.../*.md`.

Настройте CLI:

```bash
export MINUTKA_API_URL=http://127.0.0.1:8787
export MINUTKA_API_TOKEN=<admin-token>
```

## 1. Найти восстановимую версию

```bash
npm run cli -- admin context-document-versions \
  --employee emp_pilot \
  --path /proc/context/00_inbox/example.md
```

По умолчанию команда показывает до 20 версий от новых к старым. Для другого ограниченного окна используйте `--limit` от 1 до 100:

```bash
npm run cli -- admin context-document-versions \
  --employee emp_pilot \
  --path /proc/context/00_inbox/example.md \
  --limit 50
```

Вывод содержит `UPDATED_AT`, `SIZE_BYTES` и непрозрачный `VERSION`. Delete markers не выводятся: выбрать можно только версию, которую сервис способен восстановить.

Выберите версию по времени и ожидаемому размеру. Не редактируйте `VERSION` и не пытайтесь преобразовать его в object key.

## 2. Восстановить выбранную версию

```bash
npm run cli -- admin restore-context-document \
  --employee emp_pilot \
  --path /proc/context/00_inbox/example.md \
  --version <VERSION>
```

Успешная команда печатает новый текущий version ID. Историческая версия не становится текущей напрямую: сервис читает выбранный owner-scoped snapshot и записывает его содержимое как новую текущую версию канонического документа.

Если команда печатает `Version not found`, повторно получите список версий и проверьте employee ID, handle и `VERSION`. Не переходите к ручной работе с object key.

## 3. Проверить результат

Попросите владельца прочитать документ обычным assistant-инструментом по тому же `/proc/context/.../*.md` handle и подтвердить содержимое. Для операторской технической проверки повторите список:

```bash
npm run cli -- admin context-document-versions \
  --employee emp_pilot \
  --path /proc/context/00_inbox/example.md \
  --limit 3
```

Первая строка должна содержать новый version ID, напечатанный командой восстановления. В аудите появляется `context_document_mutated` с `operation: restore`, handle, outcome и version; содержимое документа в metadata не записывается.

## Безопасность

- Обе команды требуют operator-токен; employee- и service-токены получают `403`.
- Employee ID задаёт owner scope. Версия другого владельца возвращает `not_found` и не изменяет его документ.
- Принимаются только Markdown handles `/proc/context/*.md`; storage-пути и object key отклоняются.
