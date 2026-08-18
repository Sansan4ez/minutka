# Удаление личных данных сотрудника

Оператор выполняет запрос сотрудника одной irreversible-командой через typed use-case. Агент только объясняет процедуру и передаёт запрос оператору; инструмента удаления у агента нет. Клиентская компания в процедуре не участвует.

Основание: [RFC исследовательского корпуса §2.10–2.11](../architecture/rfc-minutka-research-corpus-and-reporting.md#210-retention-и-удаление) и активный процесс [`consent_and_privacy`](../../vault/assistant/processes/consent_and_privacy.md).

## Что удаляется

- participant и профиль сотрудника;
- consent snapshot (вместо него остаётся только обезличенный факт удаления);
- история диалога, summaries, feedback и личные insights;
- личные активности;
- расписания и журнал их срабатываний;
- Telegram-session, action messages и pending-action groups;
- черновик онбординга;
- личные идеи, задачи и confirmation records унаследованного runtime;
- личные документы, blobs, файлы и артефакты, включая все версии объектов MinIO;
- личные audit events и owner-scoped usage records;
- research execution traces и evaluation cases, связанные с `subject_key` сотрудника (удаляются каскадно вместе с participant);
- canonical messages и activities, связанные с тем же subject.

Что **не** удаляется:

- одна audit-запись `employee_data_deleted` без employee id и персонального metadata;
- агрегированные usage-счётчики: отдельного cross-user aggregate store в пилоте нет, поэтому сохранять или удалять там нечего; owner-scoped usage rows удаляются;
- уже переданный компании client artifact не отзывается автоматически. Если отчёт ещё не передан, operator запускает его пересчёт из оставшегося canonical evidence.

До cleanup-задачи `mnt-cycle-completion-4gd.16` legacy `minutka_reporting.anonymized_activities` физически не связана с subject и обслуживается отдельной старой purge-командой. Это временная несовместимость legacy storage, а не активное обещание `privacy-v6`: canonical corpus/traces/evaluation requested subject удаляются сейчас, legacy table удаляется целиком в следующем срезе до integration gate.

Удаление participant отзывает digest старого инвайта. Повторное подключение возможно только после выпуска нового инвайта оператором.

## Подготовка

1. Убедитесь, что запрос пришёл от нужного сотрудника по действующему каналу, и зафиксируйте операторский тикет вне персонального содержимого.
2. Загрузите production-переменные PostgreSQL и MinIO.
3. Не запускайте команду параллельно с обработкой сообщений этого сотрудника.

## Выполнение

```bash
npm run employee:data:delete -- <employee_id>
```

Команда печатает полный scope, затем требует level-2 подтверждение. Введите строку, показанную в prompt, ровно в форме:

```text
DELETE <employee_id>
```

Любой другой ввод завершает команду без удаления. После успеха команда печатает JSON со счётчиками удалённых записей и версий MinIO, а также явным перечнем сохранённого.

## Проверка

1. Убедитесь, что `deleted.participants` равен `1`, а `oldInviteRevoked` равен `true`.
2. Проверьте отсутствие subject в `minutka_research.traces`, `minutka_research.evaluation_cases`, canonical messages и activities; `preserved.anonymousDeletionAudit` должен быть `true`.
3. Попытка открыть старый invite должна вернуть `invite_not_found`.
4. Если client report ещё не передан, повторно сформируйте его и зафиксируйте recompute. Если передан — не обещайте автоматический отзыв/пересылку.
5. До `.16` отдельно выполните legacy company purge при необходимости очистить временную `anonymized_activities`; после `.16` этот шаг и поле `preserved.anonymizedActivities` исчезают.

Если удаление MinIO завершилось, а удаление PostgreSQL упало, устраните причину и повторите ту же команду: профиль ещё существует, а повторное удаление уже отсутствующих объектов безопасно. Если PostgreSQL завершился успешно, результат необратим; новый доступ создаётся только новым инвайтом.
