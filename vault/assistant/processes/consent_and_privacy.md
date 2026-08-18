# Consent and privacy boundary

## When this process applies

Use during connection and onboarding, and whenever an employee asks what «Минутка» stores, who can read the research corpus, what the company receives, how the corpus is used, how long it is kept, or how deletion works.

## Inputs

- `/proc/consent`: current consent state and privacy version.
- `/proc/profile`: only the authenticated employee's sanitized profile context when needed.
- `/docs/privacy-boundary.md`: runtime handling of conversation history, research access, and providers.
- `/AGENTS.md`: core privacy baseline.

## Process

1. Show the short connection consent text below verbatim before acceptance; substitute only the immutable policy URL. Make the full canonical text available before acceptance.
2. For later questions, distinguish the employee's own view, the trusted research team's full tenant-scoped corpus access, and the company's separate client report. Do not describe `subject_key` as anonymity: it is a random research pseudonym used to link evidence and support deletion/recompute.
3. State the purposes exactly: manual process analysis, prompt/taxonomy improvement, and evaluation. The pilot corpus is not used for model training or fine-tuning.
4. Explain that the pilot has no automatic TTL. Retention and deletion are manual operator procedures: company/group purge removes the selected research scope; an employee request removes the participant and records linked to their `subject_key`; reports not yet delivered are recomputed from the remaining evidence. A client artifact already delivered is not silently recalled or replaced.

## Short connection consent text

<!-- minutka-consent-short:start -->
«Минутка» — бот для короткой диагностики рабочих рутин. Утром и вечером он помогает отметить, чем вы занимались и что отнимало время.

Принимая, вы соглашаетесь с политикой по ссылке:
• Исследовательская команда «Алгоритма» получает полный корпус вашей учебной группы: разговоры, активности, feedback и технические execution traces, связанные случайным псевдонимом вместо имени.
• Корпус нужен для ручного анализа процессов, улучшения промптов и таксономии и evaluation версий продукта; для обучения и fine-tuning моделей он не используется.
• Компания получает только проверенный итоговый отчёт и карту автоматизации — без разговоров, traces, research-псевдонимов и доступа к БД.
• Текст и нужный контекст передаются LLM-провайдеру, голос — STT-провайдеру; аудио не сохраняется.
• Автоматического срока удаления в пилоте нет. Оператор вручную удаляет данные по сотруднику, группе или компании; ещё не переданный отчёт после удаления пересчитывается.

Полный текст доступен до принятия по кнопке «📄 Подробнее».
Политика: {{privacyPolicyUrl}}
<!-- minutka-consent-short:end -->

## Full connection consent text

<!-- minutka-consent-full:start -->
Подтверждая согласие, вы разрешаете «Минутке» обрабатывать данные для помощи вам и исследования рабочих процессов.

1. Сервис сохраняет историю диалога, профиль и настройки, структурированные активности, feedback, персональные выводы и отчёты. Для каждого запуска агента также сохраняется технический execution trace: использованный контекст, шаги модели, вызовы инструментов и результаты, ответ или ошибка, latency и usage.
2. Для исследовательской связи записей участнику назначается случайный group-scoped псевдоним `subject_key`. Он не строится из имени или Telegram ID, не является credential и не передаётся компании. Внутренний identity mapping остаётся у оператора, поэтому это псевдонимизация, а не обещание необратимой анонимности.
3. Доверенная исследовательская команда «Алгоритма» может читать полный tenant-scoped корпус выбранной компании и учебной группы: сообщения и ответы, structured activities, execution traces, feedback, evidence и evaluation-разметку. Этот доступ нужен для ручного анализа рабочих процессов, улучшения промптов и таксономии, проверки качества extraction и offline evaluation текущих и новых версий продукта.
4. В текущем пилоте корпус не используется оператором для обучения или fine-tuning моделей. Добавление такой цели потребует новой версии политики и повторного согласия до продолжения участия.
5. Компания-клиент не получает доступ к корпусу, traces, `subject_key`, identity mapping, research API, БД или внутренним интерфейсам. Ей передаётся только отдельно подготовленный и проверенный client report — карта автоматизации с evidence summary, confidence, ограничениями и рекомендациями — без исходных разговоров, research notes и персональных оценок сотрудника. По согласованной операционной процедуре компании может быть сообщён только факт участия.
6. Автоматического срока удаления corpus и traces в пилоте нет: данные сохраняются для повторного анализа и evaluation, пока оператор не выполнит ручную процедуру retention или удаления. Служебные Telegram/onboarding/confirmation записи могут иметь отдельные технические сроки из runtime-конфигурации; они не являются сроком хранения исследовательского корпуса.
7. Ручной purge компании удаляет её исследовательский scope; purge учебной группы — scope этой группы; запрос сотрудника удаляет participant, профиль, Telegram-привязку, разговоры, активности, traces, feedback, evaluation cases, персональные выводы и другие записи, связанные с его `subject_key`. После удаления старый инвайт перестаёт работать, а вернуться можно только по новому.
8. Report path каждый раз читает актуальный canonical corpus. Если correction или purge меняет evidence до передачи отчёта, отчёт пересчитывается. Уже переданный компании итоговый документ не отзывается и не пересылается автоматически; решение о его замене принимает оператор по отдельной процедуре.
9. Credentials, токены, пароли, auth headers и invite secrets фильтруются до сохранения research traces. Обычный текст разговора, включая рабочие детали и имена, входит в корпус и доступен исследовательской команде в границах выбранной компании и группы.

Текст запросов и нужный контекст, включая выбранное имя обращения без маскировки, передаются настроенному LLM-провайдеру. Телефон и Telegram-идентификаторы в assistant context не входят. Голос отдельно передаётся STT-провайдеру для расшифровки; приложение не сохраняет аудиофайл. Telegram используется как транспорт общения на условиях Telegram.

Текущие границы обработки данных: {{privacyPolicyUrl}}
<!-- minutka-consent-full:end -->

## Outputs

- The exact connection consent text before acceptance.
- A clear privacy answer consistent with the same boundary after onboarding.
- An explicit distinction between full research-team access and the company client-report boundary.
- A retention/deletion answer that names manual company/group/subject scope and report recompute.

## Privacy notes

canonical private conversation history and execution traces are intentional research corpus data. Raw conversation text is not copied into structured insights, audits, or aggregates. No direct personal identifiers in structured insights. Secret filtering does not remove ordinary personal or work content. Research reads are exact company/group-scoped typed use cases; company delivery is a separate DTO/artifact without raw corpus, traces, subject keys, or identity mapping.

## Anti-patterns

- Saying that the methodologist or research team cannot read conversations or sees only aggregates.
- Calling the corpus anonymous or claiming that `subject_key` cannot be mapped back by the operator.
- Saying that a universal ≥5 threshold controls access; contributor counts express evidence confidence, not the privacy boundary.
- Saying that data is automatically deleted after the report or after a fixed TTL.
- Saying that an employee deletion leaves linked research traces or activities behind.
- Saying that the company receives raw evidence, conversations, traces, subject keys, or an internal evidence pack.
- Hiding manual analysis, prompt/taxonomy improvement, evaluation, or provider transmission behind vague legal language.
- Claiming that the corpus is used for model training or fine-tuning in the current pilot.

## Dependencies

Developer provenance only. These repository files are validated by maintainers and are not runtime inputs or prompt content.

- `docs/architecture/rfc-minutka-research-corpus-and-reporting.md#211-consent-до-первого-внешнего-пилота`
- `docs/product/privacy-v6.html`
- `src/application/research-corpus-export.ts`
- `src/application/company-reporting.ts`
- `src/application/profile-store.ts`
- `src/application/research-scope-purge.ts`
- `src/application/employee-data-deletion.ts`
