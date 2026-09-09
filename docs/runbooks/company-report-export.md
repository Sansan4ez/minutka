# Выгрузка evidence и клиентского отчёта компании

Живой report path строится из канонических `minutka_private.activities` и group-scoped participant bindings. Отдельного reporting store для activities нет. Каждый запуск перечитывает текущее состояние, поэтому correction, персональное удаление или purge канонических activities сразу меняют результат.

Архитектурная граница задана [RFC исследовательского корпуса §2.7–2.10](../architecture/rfc-minutka-research-corpus-and-reporting.md#27-внутренний-evidence-pack) и [шаблоном evidence/client report](../product/evidence-pack-and-client-report-template.md). В v2 компания получает карту рутин и быстрых улучшений; raw labels и evidence остаются во внутреннем отчёте.

## Команда и порядок цикла

Операторский цикл выполняется в таком порядке:

1. Проверить справочник рутин.
2. Собрать первый internal/client report с этим справочником.
3. Посмотреть остаток свободных labels через `suggest`, проверить предложения методологом и сохранить исправленную версию справочника.
4. Повторно собрать отчёт.
5. Проверить детерминированный `internal.preflightFindings` и, при необходимости, дополнить его `preflight-llm`.
6. Исправить или подтвердить high-находки через `resolve-finding`.
7. Передать компании только результат `publish`.

Все промежуточные файлы держите в операторском каталоге, не добавляйте их в репозиторий и не передавайте компании.

На production-хосте используйте установленные обёртки от имени `minutka`, загружая тот же `EnvironmentFile`, что и runtime. Не копируйте секреты в shell history:

```bash
sudo systemctl show minutka.service -p Environment --value \
  | tr ' ' '\n' \
  | sudo -u minutka bash -c \
    'set -a; while IFS= read -r item; do export "$item"; done; . /run/secrets/rendered/minutka.env; set +a; exec /run/current-system/sw/bin/minutka-company-report "$@"' \
  company-report build --company company_acme --group group_acme_2026_09 \
  --directory /srv/minutka/operator/routine-directories/routine-directory.company_acme.json \
  --out /srv/minutka/operator/reports/company-report.draft.json
```

Для `validate`/`suggest` аналогично используйте `minutka-routine-directory`; output-файлы остаются в `/srv/minutka/operator/reports/` с режимом `0600` и владельцем `minutka`.

### 1. Проверить справочник

```bash
npm run routine-directory -- validate \
  --company company_acme \
  --file ./operator/routine-directory.company_acme.json
```

Команда проверяет схему `minutka-routine-directory/v1`, компанию, версию, provenance, уникальность ids и назначение quick win. `version` — монотонное целое без префикса (`"1"`, `"2"`, …); не используйте `v1`, даты или другие строки. `validate` и все команды отчёта проверяют tombstones из того же каталога, что и файл справочника.

В выводе `sections` записывайте в операторские notes счётчики `roleId`, `entries` и `characters` для каждой роли. Секция роли ограничена 40 записями и 12 000 Unicode code points в её extractor-проекции. `directory_section_over_budget` означает, что хотя бы одна секция превышает один из лимитов; runtime отключит только такие секции, но для операторского цикла справочник надо сократить и повторить `validate`. В отчёт можно передавать только справочник, который вернул `ok: true`.

### 2. При необходимости восстановить reviewed assignments исторического корпуса

Миграция `0078` намеренно не делает semantic backfill. Reviewed replay — разрешённый путь по решению [RFC инвентаря рутин §8.18](../architecture/rfc-routine-inventory-and-quick-wins.md#8-решения-оператора-и-открытые-вопросы). Для activities, собранных до подключения справочника, подготовьте вне git review-pack `minutka-routine-assignment-replay/v1`: exact `activityId`, `roleId`, проверенные `routineId` и `routineLabel`, scope и provenance запуска. Применяйте только методологически проверенные назначения:

```bash
sudo systemctl show minutka.service -p Environment --value \
  | tr ' ' '\n' \
  | sudo -u minutka bash -c \
    'set -a; while IFS= read -r item; do export "$item"; done; . /run/secrets/rendered/minutka.env; set +a; exec /run/current-system/sw/bin/minutka-routine-assignment-replay "$@"' \
  routine-replay \
    --file /srv/minutka/operator/reports/reviewed-routine-assignments.json \
    --directory /srv/minutka/operator/routine-directory.company_acme.json
```

`--directory` обязателен: команда до начала транзакции сверяет версию pack, каждую роль и каждый `routineId` с этим справочником (включая tombstones из его каталога). Затем она атомарно обновляет только exact active rows указанной company/group/role, увеличивает revision, пишет message-free `corrected` в `activity_revisions` и content-free audit-событие запуска со счётчиками. Повтор того же pack идемпотентен; отсутствующая, уже иначе исправленная или cross-scope строка откатывает весь pack. Свободные и неатрибутированные activities не включайте: они честно остаются в `other`.

### 3. Собрать первый отчёт

```bash
npm run company-report -- build \
  --company company_acme \
  --group group_acme_2026_09 \
  --directory ./operator/routine-directory.company_acme.json \
  --out ./operator/company-report.draft.json
```

По умолчанию отчёт включает только activities, чья `activityDate` входит в inclusive период группы. Для точного воспроизведения immutable corpus export дополнительно передайте его `manifest.exportedAt`:

```bash
  --recorded-before 2026-09-04T10:15:59.635Z
```

Тот же cutoff обязан использоваться во всех последующих `build`, `preflight-llm`, `resolve-finding` и `publish`, иначе hash findings-файла станет stale или отчёт незаметно включит более поздние записи.

Справочник читается этой in-process командой рядом с базой и не передаётся через HTTP. HTTP `GET /v1/admin/companies/:id/report` предназначен только для отчёта без справочника (coverage, time budget и ограничения).

Команда возвращает два DTO:

- `internal` (`minutka-internal-report/v2`) — операторский evidence report с activity refs, subject keys, `timeBudget`, `routines` и `preflightFindings`; его не передают компании;
- `client` (`minutka-client-report.v2`) — отдельная карта рутин без subject keys, employee ids, raw messages, traces, source refs и identity mapping.

Пока справочник не передан, report path не называет рутины в client DTO: остаются coverage, бюджет по категориям и ограничения. Справочник применяется детерминированно; модель не запускается во время обычной выгрузки.

Проверьте структуру результата до следующего шага:

```bash
jq '{schemaVersion: .internal.schemaVersion, directoryVersion: .internal.directoryVersion, routines: (.internal.routines | length), preflightFindings: .internal.preflightFindings}' \
  ./operator/company-report.draft.json
```

### 4. Предложить записи для остатка

После первого отчёта запустите предложение записей только для свободных labels текущего цикла:

```bash
npm run routine-directory -- suggest \
  --company company_acme \
  --group group_acme_2026_09 \
  --file ./operator/routine-directory.company_acme.json \
  --out ./operator/routine-directory-suggestions.group_acme_2026_09.json
```

`routine-directory suggest` не изменяет справочник. Он возвращает review-pack с предложениями `attach`, `create` и `free` и опорными фразами. Методолог проверяет предложения, добавляет принятые записи или назначения в операторский JSON, увеличивает `version` на единицу и снова выполняет `validate`. `leave_free` остаётся свободным и не получает клиентского имени.

#### Выпустить новую company-scoped версию справочника

Справочник общий для компании, а не для одной группы: активный файл `routine-directory.<companyId>.json` используется extractor-ом новых сообщений всех групп этой компании и report-командами, которым передан этот путь. Поэтому предложения одного цикла нельзя принимать автоматически. Методолог сначала проверяет каждое изменение в scope исходной роли и компании:

- `attach` означает, что свободная формулировка действительно называет уже существующую рутину; activity assignment выполняется отдельно через reviewed typed replay/correction, а не изменением одного справочника;
- `create` добавляет новую запись со стабильным новым `id`, предметным `workCategory`, `quickWin` или `deep_dive`, примерами и provenance; новый `id` не должен дублировать или повторно использовать tombstoned id;
- `free` остаётся без назначения, если evidence неоднозначно;
- переименование существующей записи сохраняет её `id`; удалённый id заносится в `routine-directory.<companyId>.tombstones.json` и больше не используется;
- `version` увеличивается ровно на единицу относительно активной версии. Валидатор проверяет формат версии, но сравнение с активным файлом остаётся операторской проверкой.

На production храните immutable versioned copy и отдельный active-файл. Пример выпуска версии `3` поверх активной версии `2`:

```bash
export COMPANY_ID=company_acme
export NEXT_VERSION=3
export DIRECTORY_DIR=/srv/minutka/operator/routine-directories
export VERSIONED="$DIRECTORY_DIR/routine-directory.$COMPANY_ID.$NEXT_VERSION.json"
export ACTIVE="$DIRECTORY_DIR/routine-directory.$COMPANY_ID.json"

# Новый reviewed JSON сначала передаётся в домашний каталог оператора,
# затем устанавливается как immutable versioned copy с production permissions.
sudo install -o minutka -g minutka -m 0600 \
  /home/admin/routine-directory.$COMPANY_ID.$NEXT_VERSION.json \
  "$VERSIONED"

sudo systemctl show minutka.service -p Environment --value \
  | tr ' ' '\n' \
  | sudo -u minutka bash -c \
    'set -a; while IFS= read -r item; do export "$item"; done; . /run/secrets/rendered/minutka.env; set +a; exec /run/current-system/sw/bin/minutka-routine-directory "$@"' \
  routine-directory validate --company "$COMPANY_ID" --file "$VERSIONED"

# Активировать только после ok:true. install создаёт файл рядом, mv атомарно
# заменяет active path; работающий runtime продолжает старую in-memory версию
# до контролируемого restart.
sudo install -o minutka -g minutka -m 0600 \
  "$VERSIONED" "$DIRECTORY_DIR/.routine-directory.$COMPANY_ID.next"
sudo mv -f "$DIRECTORY_DIR/.routine-directory.$COMPANY_ID.next" "$ACTIVE"
sudo systemctl restart minutka.service
sudo journalctl -u minutka.service -n 100 --no-pager \
  | grep 'routine directory loaded'
```

После рестарта журнал должен показать ожидаемые `companyId`, `version`, число entries и `disabled sections 0`. Затем заново выполните `build → preflight-llm → resolve-finding → publish`: изменение имени, категории или quick-win назначения меняет client DTO и делает прежний findings envelope устаревшим.

Versioned copy предыдущей версии не удаляйте: она нужна для rollback и воспроизводимости старого цикла. Для rollback так же атомарно установите прежний versioned-файл в active path и перезапустите runtime. Уже опубликованный client artifact при этом не переписывается. Если старый отчёт нужно пересобрать побайтно совместимо, передавайте использованную тогда versioned copy и тот же `--recorded-before`, а не текущий active-файл.

### 5. Повторно собрать отчёт и проверить preflight

```bash
npm run routine-directory -- validate \
  --company company_acme \
  --file ./operator/routine-directory.company_acme.json

npm run company-report -- build \
  --company company_acme \
  --group group_acme_2026_09 \
  --directory ./operator/routine-directory.company_acme.json \
  --recorded-before 2026-09-04T10:15:59.635Z \
  --out ./operator/company-report.v2.json

jq '.internal.preflightFindings' ./operator/company-report.v2.json
```

`internal` v2 содержит `timeBudget`, `routines` и `preflightFindings`. У каждой routine проверьте каноническое имя, `scope`, evidence summary, stated recurrence, systems, confidence, quick win или deep-dive. Не переносите в client DTO `routineKey`, варианты labels, subject keys или evidence refs.

Для содержательной проверки имён отдельно запустите операторский LLM-шаг:

```bash
npm run company-report -- preflight-llm \
  --company company_acme \
  --group group_acme_2026_09 \
  --directory ./operator/routine-directory.company_acme.json \
  --out ./operator/preflight-findings.json
```

Команда пересобирает internal DTO из canonical activities, передаёт модели только имена и варианты рутин и сохраняет envelope `minutka-report-preflight-findings/v1` с `scope`, `reportVersion` (sha256 текущего client DTO) и детерминированным lint вместе с результатом модели. Ответ модели содержит только `ok` или `flag`; при `flag` сохраняется причина, исходное имя не переписывается. `subjectKey`, сообщения и `evidenceRefs` в prompt не передаются. Невалидный ответ или ошибка провайдера прерывают команду до записи результата.

### 6. Решить high-находки

Методолог читает объединённые `internal.preflightFindings` и `preflight-findings.json`. High-находка не означает автоматическое удаление текста: методолог либо подтверждает безопасный результат, либо исправляет справочник и пересобирает отчёт.

```bash
npm run company-report -- resolve-finding \
  --company company_acme \
  --group group_acme_2026_09 \
  --directory ./operator/routine-directory.company_acme.json \
  --finding <finding-id> \
  --decision verified \
  --findings ./operator/preflight-findings.json
```

Для исправленной записи используйте `--decision fixed`. Замечание методолога храните в `methodologistNote` соответствующей записи справочника. Для детерминированной находки файл можно не передавать; для LLM-находки передайте тот же `preflight-findings.json`. После изменения справочника снова пройдите шаги `validate`, `build` и preflight: решение относится к hash конкретного client DTO.

### 7. Опубликовать client DTO

```bash
npm run company-report -- publish \
  --company company_acme \
  --group group_acme_2026_09 \
  --directory ./operator/routine-directory.company_acme.json \
  --findings ./operator/preflight-findings.json \
  --out ./operator/client-report.json
```

Команда заново пересчитывает report без передачи справочника через транспорт и требует envelope findings-файла с тем же `scope` и `reportVersion`. Отсутствующий или невалидный файл даёт `missing_findings`, чужой или устаревший hash — `stale_findings`; артефакт не создаётся. Затем findings объединяются с текущим lint и проверяются решения методолога. Нерешённая high-находка даёт `unresolved_high_findings`, не создаёт client-файл и пишет в audit только scope, finding ids, причину и hash DTO. Medium и low находки publish не блокируют. При `ok: true` в `client-report.json` находится единственный артефакт, который можно передать компании.

## Confidence policy

Пороговые значения определены вместе в `src/application/company-reporting.ts`:

```text
signalSubjects = 2
confirmedSubjects = 3
confirmedObservations = 5
confirmedDates = 3
```

- `hypothesis`: единичное или слабое evidence;
- `signal`: минимум два subjects **или** повторяемость одной рутины в несколько дат;
- `confirmed`: минимум три subjects, пять observations и три даты.

Contributor считается по distinct `subject_key`: двадцать activities одного человека остаются одним contributor. Роль не сливается в искусственный `other`: если `roleId` рутины есть в справочнике компании, role label всегда является client scope независимо от числа contributors, а confidence следует тем же policy, включая `signal` при повторяемости в несколько дат. Для роли с одним contributor ≈часы и сигналы трения остаются, сигналы энергии/стресса отсутствуют, а `coverage.limitations` называет самоотчёт одного человека и не-оценочный характер карточки.

## Проверка результата

1. Сверьте `internal.companyId` и `internal.groupId` с выбранной группой.
2. Проверьте coverage: invited participants, contributors, observations, active dates, unsized и unattributed observations.
3. Проверьте `timeBudget`: категории берутся только из `workCategory` проверенных записей справочника; суммы observations и unsizedObservations совпадают с coverage; сумма известных часов совпадает с bucket-оценками всего scope; сумма долей равна 1 при ненулевых часах. Остаток `other` обязателен при неразрешённых рутинах и сопровождается limitation. У каждой клиентской routine проверьте каноническое имя справочника, scope, contributors, observations, dates, приблизительные часы, системы, stated recurrence и confidence.
4. Убедитесь, что routine названа словами справочника, а не raw label; `routineKey`, варианты, subject keys, employee ids, source refs и traces отсутствуют в client DTO.
5. Проверьте quick win: он взят из закрытого каталога записи справочника и содержит `title`, `whatChanges`, `effort`, `whoCanDo`, `humanInTheLoop`, `firstStep`. Если назначения нет, routine идёт в `deepDive`, а не становится рекомендацией.
6. Проверьте `preflightFindings`: high-находки имеют решение методолога для текущего hash отчёта; незакрытая high-находка должна блокировать publish.
7. Human-impact/friction signals поднимают рутину в разделе «Что мешает» (`frictionRoutines`), но не меняют confidence и quick win.
8. При слабом coverage оставьте рассчитанный policy confidence (`hypothesis` или `signal`), ограничения зафиксируйте в `coverage.limitations`, а недоступные выводы — в `cannotConclude`; не повышайте confidence редакторским текстом. Для одного contributor проверяйте, что client scope равен label справочной роли (или «группа», только если справочного `roleId` нет), ≈часы обозначены как порядок величины, сигналы трения сохранены, сигналы энергии/стресса отсутствуют, а `coverage.limitations` содержит строку про самоотчёт одного участника. Перед передачей методолог подтверждает или редактирует имя и quick win.
9. После correction, purge или изменения справочника запустите весь цикл повторно: сохранённого materialized report source нет, результат должен пересчитаться из актуальных canonical activities и текущей версии справочника.

Отдельного reporting writer/table нет: correction и purge применяются к canonical subject-aware evidence, после чего report command пересчитывает результат.

Личный финальный отчёт сотрудника в этот артефакт не входит и готовится отдельным контуром: [завершение двухнедельного цикла](end-of-cycle.md). Порядок конца цикла — сначала личные отчёты, затем evidence pack и клиентский отчёт, и только потом ручные удаления.
