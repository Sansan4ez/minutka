# Просмотр и коррекция личного контекста в Telegram

Runbook проверяет узкий employee-only flow `personal_context_review`. Это не база знаний: бот показывает только подтверждённые profile fields текущего сотрудника и не открывает generic document tools.

## Предусловия

- сотрудник прошёл consent и онбординг;
- Telegram-сессия связана с его `employeeId`;
- runtime запущен через `npm run telegram:dev` или production Telegram mode.

## Просмотр

Сотрудник отправляет:

```text
/context
```

Ожидается две явно разделённые секции:

1. `Ваш подтверждённый профиль` — обращение, стиль и длина ответа, timezone, точная должность, а также только заполненные optional fields;
2. `Осторожные наблюдения` — до появления отдельного confirmed-summary store бот сообщает, что подтверждённых наблюдений нет.

Ответ не должен содержать `employeeId`, company/group/role ids, `subject_key`, chat/user ids Telegram, message ids, raw conversation или traces.

## Коррекция

Коррекция идёт обычным сообщением через тот же agent-led runtime, например:

```text
Зови меня Максим и отвечай короче.
```

или:

```text
Мой часовой пояс Europe/Moscow. Моя роль — координирую тендеры и подрядчиков.
```

Агент выбирает `personal_context_review` и вызывает owner-bound `updatePersonalContext` только с явно названными allow-listed полями. Неоднозначное значение требует одного уточнения. После ответа повторить `/context` и проверить сохранённое значение.

Точная должность из tenant directory в этом flow read-only. Для её смены оператор использует отдельную tenant/onboarding процедуру; нельзя подменять `roleId` самоописанием.

## HTTP-проверка

Employee token связывает identity; `employeeId` в body отсутствует:

```bash
curl -fsS \
  -H "Authorization: Bearer $MINUTKA_EMPLOYEE_TOKEN" \
  "$MINUTKA_API_URL/v1/me/context"

curl -fsS -X PATCH \
  -H "Authorization: Bearer $MINUTKA_EMPLOYEE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"preferredName":"Максим","responseLength":"short","timezone":"Europe/Moscow"}' \
  "$MINUTKA_API_URL/v1/me/context"
```

Unknown fields and an empty patch return `400 invalid_request`. A token of employee B reads and changes only B's context even if request content mentions employee A.

## Диагностика

- `404 profile_not_found` — онбординг не завершён или профиль удалён;
- `409 persistence_conflict` — профиль ссылается на отсутствующую tenant-directory role; сначала восстановить справочник;
- `400 invalid_request` — поле не входит в closed set, пусто или нарушает length/enum/timezone contract.

Не исправлять flow прямым SQL и не подключать `listDocuments`, `readDocument`, `searchDocuments`, `createContextNote` или document mutation tools.
