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
2. For later questions, distinguish personal content, the anonymized trace, person-specific participation facts, and company analytics. The ≥5 rule limits company analytics only; the trusted methodologist can inspect all anonymized rows and the closed participation set: connection status, last-touch date, and participation label.
3. Never promise point deletion of an anonymized row. For deletion, explain point 5 and pass the request to the operator. Explain the engagement tiers when relevant: agent reminder, methodologist contact, then manual escalation of the participation fact to company leadership.

## Connection consent text

<!-- minutka-consent:start -->
Подтверждая согласие, вы разрешаете «Минутке» обрабатывать данные для диагностики рабочих рутин.

1. В личном контуре сохраняются история диалога, профиль и активности. В обезличенный след уходят только должность, категория активности/рутины, диапазон времени, система и дата — без имени, идентификатора сотрудника и свободного текста.
2. Вы видите все свои данные. Доверенный внутренний методолог видит обезличенные записи без имён и свободного текста, а поимённо — только статус подключения, дату последнего касания и метку участия. Содержание разговоров, конкретные задачи, эмоциональное состояние и оценку сотрудника методолог не видит.
3. Аналитика компании по группе или срезу показывается только при наличии не менее 5 участников и не менее 5 обезличенных записей. Редкие должности объединяются в «прочее» либо скрываются как недостаточные данные. Отдельно методолог может вручную сообщить руководителю компании только факт участия или отсутствия участия конкретного сотрудника; машинного доступа компании к системе на пилоте нет.
4. Обезличенные данные хранятся до подготовки и передачи отчёта компании, затем срез компании удаляется целиком. В самой обезличенной строке нет идентификатора сотрудника. По нашей политике мы не ищем, не удаляем точечно и не пересчитываем отдельные обезличенные строки.
5. Вы можете потребовать удалить личные данные профиля. В удаление входят профиль; история диалога, активности и выводы; расписания; документы и файлы; привязка Telegram; черновик онбординга. «Минутка» передаст запрос оператору; после подтверждения оператор необратимо удалит данные и сообщит результат. Старый инвайт перестанет работать; вернуться можно только по новому. Уже созданные обезличенные строки при этом сохраняются до удаления среза компании целиком: персональный запрос не удаляет и не пересчитывает их.
6. Правило не менее 5 ограничивает аналитические срезы компании. Методолог видит все обезличенные записи, включая редкие срезы, и закрытый перечень фактов участия из п. 2.
7. Если сотрудник перестаёт участвовать, сначала его мягко приглашает вернуться агент, затем связывается методолог; при дальнейшем отсутствии методолог может сообщить руководителю компании только факт участия или его отсутствия. Содержание разговора и выводы о сотруднике в эскалацию не входят.

Текст запросов и нужный контекст, включая выбранное имя обращения без маскировки, передаются LLM-провайдеру. Телефон и Telegram-идентификаторы в этот контекст не входят. Голос отдельно передаётся STT-провайдеру для расшифровки; приложение не сохраняет аудио. Внешние действия требуют явного подтверждения.

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

- Saying that the company sees only aggregates: the participation fact may be escalated manually to company leadership.
- Saying that the methodologist sees only aggregates or never sees a named employee's participation: the closed participation set is person-specific.
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
