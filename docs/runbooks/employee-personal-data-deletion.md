# Удаление личных данных сотрудника

Оператор выполняет запрос сотрудника одной irreversible-командой через typed use-case. Агент только объясняет процедуру и передаёт запрос оператору; инструмента удаления у агента нет. Клиентская компания в процедуре не участвует.

Это subject scope. Purge всей компании или одной учебной группы выполняется отдельной процедурой [`research-scope-purge.md`](./research-scope-purge.md).

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

Structured activity существует только как canonical subject-linked record, поэтому каскадное удаление participant не оставляет отдельной несопоставимой reporting-копии.

Удаление participant отзывает digest старого инвайта. Повторное подключение возможно только после выпуска нового инвайта оператором.

## Подготовка

1. Убедитесь, что запрос пришёл от нужного сотрудника по действующему каналу, и зафиксируйте операторский тикет вне персонального содержимого.
2. Загрузите production-переменные PostgreSQL и MinIO.
3. Сохраните точную пару `(groupId, subjectKey)` из research scope для последующей очистки производного справочника рутин.
4. Не запускайте команду параллельно с обработкой сообщений этого сотрудника.

## Выполнение

```bash
npm run employee:data:delete -- <employee_id>
```

Команда печатает полный scope, затем требует level-2 подтверждение. Введите строку, показанную в prompt, ровно в форме:

```text
DELETE <employee_id>
```

Любой другой ввод завершает команду без удаления. После успеха команда печатает JSON со счётчиками удалённых записей и версий MinIO, а также явным перечнем сохранённого.

Если удаление MinIO завершилось, а удаление PostgreSQL упало, устраните причину и повторите ту же команду: профиль ещё существует, а повторное удаление уже отсутствующих объектов безопасно. Если PostgreSQL завершился успешно, очистите справочник рутин до пересчёта отчёта:

```bash
npm run routine-directory -- purge \
  --company <company_id> --group <group_id> --subject-key <subject_key> --dry-run
npm run routine-directory -- purge \
  --company <company_id> --group <group_id> --subject-key <subject_key>
```

Команда работает в каталоге `$ROUTINE_DIRECTORY_DIR` — том же, который читает runtime (см. [`http-api-runtime.md`](./http-api-runtime.md)): это каталог с активным файлом `routine-directory.<company_id>.json`, версиями `routine-directory.<company_id>.<version>.json` и tombstones; отдельного каталога версий нет. Без `ROUTINE_DIRECTORY_DIR` команда отказывает с `directory_dir_not_configured` и ничего не трогает; `--dir <path>` переопределяет каталог только для копии справочника.

Это удаляет целиком записи, чья provenance пересекает точную пару, включая записи в сохранённых старых версиях — заранее удалять эти копии не нужно. Если команда называет нечитаемую копию, исправьте или удалите именно этот повреждённый файл и повторите purge. Команда сохраняет незатронутый остаток в новой версии и добавляет удалённые id в tombstones. Если purge удалил хотя бы один файл, его JSON содержит `runtimeRestartRequired: true`: **обязательно перезапустите runtime** (например, `systemctl restart <unit>` — см. [`http-api-runtime.md`](./http-api-runtime.md)) и убедитесь в логе старта, что загружена очищенная версия. Purge не считается завершённым до рестарта; при пустом плане выводит `runtimeRestartRequired: false`.

## Операторские артефакты scope

После purge справочника найдите операторские output-файлы группы по обязательному суффиксу `<companyId>.<groupId>`:

```bash
sudo ls -la /srv/minutka/operator/reports/*<company_id>.<group_id>*
sudo find /srv/minutka/operator/reports -maxdepth 1 -type f \
  -name '*<company_id>.<group_id>*' -delete
```

Так удаляются все review-pack `routine-directory-suggestions`, internal drafts `company-report`, `preflight-findings` и локальный `client-report` группы. Subject key в именах и содержимом отдельных файлов не выделяется, поэтому после subject purge безопасна только пересборка всего group scope. Уже переданный компании client artifact остаётся `not_recalled` — удаление локального файла не отзывает переданную копию; не обещайте автоматический отзыв или замену.

Проверьте, что вне единственного разрешённого каталога справочника нет транзитных или сохранённых копий компании, и удалите всё найденное:

```bash
sudo find / -name 'routine-directory.<company_id>*' \
  -not -path "$ROUTINE_DIRECTORY_DIR/*" -print
# Для каждого найденного файла после проверки scope:
sudo shred -u <found_path> || sudo rm -f <found_path>
```

## Проверка

1. Убедитесь, что `deleted.participants` равен `1`, а `oldInviteRevoked` равен `true`.
2. Проверьте отсутствие subject в `minutka_research.traces`, `minutka_research.evaluation_cases`, canonical messages и activities; `preserved.anonymousDeletionAudit` должен быть `true`, а `preserved.deliveredClientArtifacts` — `not_recalled`.
3. Попытка открыть старый invite должна вернуть `invite_not_found`.
4. Убедитесь, что runtime перезапущен после purge справочника и загрузил очищенную версию.
5. Убедитесь, что операторские артефакты scope вне каталога справочника отсутствуют.
6. Если client report ещё не передан, повторно сформируйте его и зафиксируйте recompute. Если передан — не обещайте автоматический отзыв/пересылку.

После этого отчёт пересчитывается по очищенному справочнику; activities других сотрудников не удаляются. Новый доступ создаётся только новым инвайтом.
