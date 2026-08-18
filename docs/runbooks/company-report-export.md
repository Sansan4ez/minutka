# Выгрузка evidence и клиентского отчёта компании

Живой report path строится из канонических `minutka_private.activities` и group-scoped participant bindings. Отдельного reporting store для activities нет. Каждый запуск перечитывает текущее состояние, поэтому correction, персональное удаление или purge канонических activities сразу меняют результат.

Архитектурная граница задана [RFC исследовательского корпуса §2.7–2.10](../architecture/rfc-minutka-research-corpus-and-reporting.md#27-внутренний-evidence-pack) и [шаблоном evidence/client report](../product/evidence-pack-and-client-report-template.md).

## Команда

```bash
npm run cli -- admin company-report --company company_acme --group group_acme_2026_09
```

Команда возвращает два разных DTO:

- `internal` (`minutka-internal-report/v1`) — операторский evidence report с activity refs и subject keys; не передавать компании;
- `client` (`minutka-client-report.v1`) — отдельная карта возможностей автоматизации без subject keys, employee ids, raw messages, traces, source refs и identity mapping.

Перед ручной передачей извлеките только поле `client`, проверьте формулировки и пройдите boundary preflight из шаблона. HTTP/CLI остаётся операторским контуром; автоматической публикации и company account нет.

## Confidence policy

Пороговые значения определены вместе в `src/application/company-reporting.ts`:

```text
signalSubjects = 2
confirmedSubjects = 3
confirmedObservations = 5
confirmedDates = 3
```

- `hypothesis`: единичное или слабое evidence;
- `signal`: минимум два subjects **или** повторяемость одного процесса в нескольких датах;
- `confirmed`: минимум три subjects, пять observations и три даты.

Contributor считается по distinct `subject_key`: двадцать activities одного человека остаются одним contributor. Редкая роль не сливается в искусственный `other`; её process-level observation остаётся hypothesis и не превращается в оценку сотрудника.

## Проверка результата

1. Сверьте `internal.companyId` и `internal.groupId` с выбранной группой.
2. Проверьте coverage: invited participants, contributors, observations и active dates.
3. Для каждого internal bucket проверьте confidence и activity refs. В evidence pack допустимы subject keys; в client DTO — нет.
4. Убедитесь, что client recommendation описывает процесс, систему и возможность автоматизации, а не продуктивность или качество работы человека.
5. При слабом coverage оставьте hypothesis/`insufficientEvidence`; не повышайте confidence редакторским текстом.
6. После correction/purge запустите команду повторно: сохранённого materialized report source нет, результат должен пересчитаться из актуальных canonical activities.

Отдельного reporting writer/table нет: correction и purge применяются к canonical subject-aware evidence, после чего report command пересчитывает результат.
