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

### 1. Проверить справочник

```bash
npm run routine-directory -- validate \
  --company company_acme \
  --file ./operator/routine-directory.company_acme.json
```

Команда проверяет схему `minutka-routine-directory/v1`, компанию, версию, provenance, уникальность ids и назначение quick win. При старте runtime дополнительно проверяются tombstones; в отчёт можно передавать только справочник, который вернул `ok: true`.

### 2. Собрать первый отчёт

```bash
npm run company-report -- build \
  --company company_acme \
  --group group_acme_2026_09 \
  --directory ./operator/routine-directory.company_acme.json \
  --out ./operator/company-report.draft.json
```

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

### 3. Предложить записи для остатка

После первого отчёта запустите предложение записей только для свободных labels текущего цикла:

```bash
npm run routine-directory -- suggest \
  --company company_acme \
  --group group_acme_2026_09 \
  --file ./operator/routine-directory.company_acme.json \
  --out ./operator/routine-directory-suggestions.group_acme_2026_09.json
```

`routine-directory suggest` не изменяет справочник. Он возвращает review-pack с предложениями `attach`, `create` и `free` и опорными фразами. Методолог проверяет предложения, добавляет принятые записи или назначения в операторский JSON, увеличивает `version` и снова выполняет `validate`. `leave_free` остаётся свободным и не получает клиентского имени.

### 4. Повторно собрать отчёт и проверить preflight

```bash
npm run routine-directory -- validate \
  --company company_acme \
  --file ./operator/routine-directory.company_acme.json

npm run company-report -- build \
  --company company_acme \
  --group group_acme_2026_09 \
  --directory ./operator/routine-directory.company_acme.json \
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

Команда пересобирает internal DTO из canonical activities, передаёт модели только имена и варианты рутин и сохраняет детерминированный lint вместе с результатом модели. Ответ модели содержит только `ok` или `flag`; при `flag` сохраняется причина, исходное имя не переписывается. `subjectKey`, сообщения и `evidenceRefs` в prompt не передаются. Невалидный ответ или ошибка провайдера прерывают команду до записи результата.

### 5. Решить high-находки

Методолог читает объединённые `internal.preflightFindings` и `preflight-findings.json`. High-находка не означает автоматическое удаление текста: методолог либо подтверждает безопасный результат, либо исправляет справочник и пересобирает отчёт.

```bash
npm run company-report -- resolve-finding \
  --company company_acme \
  --group group_acme_2026_09 \
  --finding <finding-id> \
  --decision verified
```

Для исправленной записи используйте `--decision fixed` и при необходимости `--note`. После изменения справочника снова пройдите шаги `validate`, `build` и preflight: решение относится к hash конкретного client DTO.

### 6. Опубликовать client DTO

```bash
npm run company-report -- publish \
  --company company_acme \
  --group group_acme_2026_09 \
  --findings ./operator/preflight-findings.json \
  --out ./operator/client-report.json
```

Команда заново пересчитывает report без передачи справочника через транспорт, объединяет его findings с переданным файлом и проверяет решения методолога. Нерешённая high-находка даёт `unresolved_high_findings`, не создаёт client-файл и пишет в audit только scope, finding ids, причину и hash DTO. Medium и low находки publish не блокируют. При `ok: true` в `client-report.json` находится единственный артефакт, который можно передать компании.

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

Contributor считается по distinct `subject_key`: двадцать activities одного человека остаются одним contributor. Редкая роль не сливается в искусственный `other`; её routine-level observation остаётся hypothesis и не превращается в оценку сотрудника.

## Проверка результата

1. Сверьте `internal.companyId` и `internal.groupId` с выбранной группой.
2. Проверьте coverage: invited participants, contributors, observations, active dates, unsized и unattributed observations.
3. Проверьте `timeBudget` и у каждой клиентской routine — каноническое имя справочника, scope, contributors, observations, dates, приблизительные часы, системы, stated recurrence и confidence.
4. Убедитесь, что routine названа словами справочника, а не raw label; `routineKey`, варианты, subject keys, employee ids, source refs и traces отсутствуют в client DTO.
5. Проверьте quick win: он взят из закрытого каталога записи справочника и содержит `title`, `whatChanges`, `effort`, `whoCanDo`, `humanInTheLoop`, `firstStep`. Если назначения нет, routine идёт в `deepDive`, а не становится рекомендацией.
6. Проверьте `preflightFindings`: high-находки имеют решение методолога для текущего hash отчёта; незакрытая high-находка должна блокировать publish.
7. Human-impact signal может повысить `priority` и добавить risk, но не является routine key и не заменяет доказательство проблемы.
8. При слабом coverage оставьте hypothesis/`insufficientEvidence`; не повышайте confidence редакторским текстом. Перед передачей методолог подтверждает или редактирует имя и quick win.
9. После correction, purge или изменения справочника запустите весь цикл повторно: сохранённого materialized report source нет, результат должен пересчитаться из актуальных canonical activities и текущей версии справочника.

Отдельного reporting writer/table нет: correction и purge применяются к canonical subject-aware evidence, после чего report command пересчитывает результат.

Личный финальный отчёт сотрудника в этот артефакт не входит и готовится отдельным контуром: [завершение двухнедельного цикла](end-of-cycle.md). Порядок конца цикла — сначала личные отчёты, затем evidence pack и клиентский отчёт, и только потом ручные удаления.
