# Consent and privacy boundary

## When this process applies

Use during connection and onboarding, and whenever an employee asks what «Минутка» stores, what enters the anonymized trace, who sees it, how the company threshold works, how long data is kept, or what can be deleted.

## Inputs

- `/proc/consent`: current consent state and privacy version.
- `/proc/profile`: only the authenticated employee's sanitized profile context when needed.
- `/docs/privacy-boundary.md`: runtime handling of private conversation history and providers.
- `/AGENTS.md`: core privacy baseline.

## Process

1. Show the connection consent text below verbatim before acceptance; substitute only the immutable policy URL.
2. For later questions, distinguish personal data, the anonymized trace, the methodologist, and company aggregates. The ≥5 rule limits company visibility only; the trusted methodologist can inspect all anonymized rows, including rare slices.
3. Never promise point deletion of an anonymized row. Personal data can be deleted; the company anonymized slice remains until the report and is then removed as a whole.

## Connection consent text

<!-- minutka-consent:start -->
Подтверждая согласие, вы разрешаете «Минутке» обрабатывать данные для диагностики рабочих рутин.

1. В личном контуре сохраняются история диалога, профиль и активности. В обезличенный след уходят только должность, категория активности/рутины, диапазон времени, система и дата — без имени, идентификатора сотрудника и свободного текста.
2. Вы видите все свои данные. Доверенный внутренний методолог видит обезличенные записи и агрегаты без имён и свободного текста. Компания получает только агрегаты и паттерны, прошедшие правило минимального размера.
3. Компания видит группу или срез только при наличии не менее 5 участников и не менее 5 обезличенных записей. Редкие должности объединяются в «прочее» либо скрываются как недостаточные данные.
4. Обезличенные данные хранятся до подготовки и передачи отчёта компании, затем срез компании удаляется целиком. Связи с сотрудником в строке нет, поэтому найти и удалить её точечно или пересчитать нельзя.
5. Вы можете потребовать удалить личные данные профиля. Уже созданные обезличенные строки при этом не удаляются, потому что связи с вами в них нет.
6. Правило не менее 5 ограничивает только то, что видит компания. Методолог видит все обезличенные записи, включая редкие срезы, но без имён, идентификаторов сотрудников и свободного текста.

Текст запросов и нужный контекст передаются LLM-провайдеру. Голос отдельно передаётся STT-провайдеру для расшифровки; приложение не сохраняет аудио. Внешние действия требуют явного подтверждения.

Текущие границы обработки данных: {{privacyPolicyUrl}}
<!-- minutka-consent:end -->

## Outputs

- The exact connection consent text before acceptance.
- A clear privacy answer consistent with the same boundary after onboarding.
- canonical private conversation history remains application-owned; raw transcript text is not copied into structured insights, audits, or aggregates.
- No direct personal identifiers in structured insights or the anonymized activity trace.

## Privacy notes

The anonymized trace contains closed structured values only. It contains no employee key, raw transcript, label, rationale, obstacle wording, or exact timestamp. Company-facing reads enforce the threshold in code; methodologist access is intentionally broader but remains anonymized.

## Anti-patterns

- Saying that only company aggregates of five or more people can ever be seen: the methodologist can see all anonymized rows, including rare slices.
- Saying that an employee deletion removes their anonymized rows.
- Promising exact-time data, free-text analysis in the anonymized trace, automatic point deletion, or company access to raw rows.
- Hiding the methodologist boundary behind vague legal language.

## Dependencies

Developer provenance only. These repository files are validated by maintainers and are not runtime inputs or prompt content.

- `docs/architecture/rfc-minutka-tenancy-and-reporting.md#26-consent`
- `src/application/activity-collection.ts`
- `src/application/company-reporting.ts`
- `src/application/profile-store.ts`
