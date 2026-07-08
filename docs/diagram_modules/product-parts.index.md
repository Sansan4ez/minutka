# Product Parts Index

## Product Parts

### Product Part: telegram-bot-shell
- Id: telegram-bot-shell
- Title: Telegram Bot Shell
- Purpose: Даёт сотруднику основной вход в продукт через Telegram: онбординг, ежедневные касания, голосовые и текстовые сообщения, личные итоги, настройки и управление личными данными.
- Status: generated

### Product Part: ai-agent-backend-runtime
- Id: ai-agent-backend-runtime
- Title: AI Agent Backend Runtime
- Purpose: Интерпретирует сообщения сотрудника, управляет AI-диалогом, использует личный контекст, извлекает и обезличивает сигналы, а также обращается к внешним AI/STT-зависимостям через безопасную runtime-границу.
- Status: generated

### Product Part: methodologist-web-panel
- Id: methodologist-web-panel
- Title: Methodologist Web Panel
- Purpose: Даёт методологу команды Algorithm рабочее место для запуска потоков, управления участниками, мониторинга вовлечённости, мягких напоминаний, подготовки отчётов и клиентской карты автоматизации без доступа к личным разговорам.
- Status: generated

### Product Part: data-storage-and-privacy-layer
- Id: data-storage-and-privacy-layer
- Title: Data Storage and Privacy Layer
- Purpose: Хранит личный контекст, историю, согласия, агрегированные и обезличенные сигналы, отчётные данные и аудит, удерживая правила доступа между персональными данными сотрудника и аналитикой компании.
- Status: generated

## Assumptions / Open Questions

- Индекс отражает подтверждённую корректировку: `External AI and Speech Providers` больше не является отдельным Product Part, а рассматривается как внешняя зависимость, доступ к которой находится внутри `AI Agent Backend Runtime`.
- Индекс отражает подтверждённую корректировку: `Reporting and Automation Map Generation` больше не является отдельным Product Part, а входит в `Methodologist Web Panel` как операторский контур подготовки отчётов и карты автоматизации.
- `Telegram Bot Shell` и `Methodologist Web Panel` остаются отдельными shell, потому что у них разные аудитории, сценарии и границы доступа.
- `Data Storage and Privacy Layer` остаётся отдельным Product Part, но материализован упрощённо: личный контекст, обезличенные агрегаты, согласия/audit и удаление личных данных.
- Обезличивание считается AI-assisted обработкой внутри `AI Agent Backend Runtime`; `Data Storage and Privacy Layer` хранит подготовленные результаты и удерживает правила доступа.
- `AI Agent Backend Runtime` материализован упрощённо: AI-диалог, reasoning по личному контексту, извлечение/обезличивание сигналов и доступ к AI/STT-провайдерам.
- Персональные недельные и финальные итоги сотрудника агрегируются из `Data Storage and Privacy Layer` и должны быть доступны сотруднику через Telegram; клиентская карта автоматизации готовится в контуре `Methodologist Web Panel`.
- Удаление данных сотрудником удаляет личный контекст и историю; уже созданные обезличенные агрегаты не пересчитываются автоматически.
- `Methodologist Web Panel` материализована упрощённо: запуск потока, мониторинг вовлечённости, мягкие напоминания и подготовка клиентской карты автоматизации.
- `Telegram Bot Shell` материализован упрощённо: онбординг/согласие, ежедневный диалог, личная зона и итоги, настройки/feedback и поверхность удаления данных.
- Расписание ежедневных prompts и workflow-логика остаются будущей зоной `AI Agent Backend Runtime`.
- Program flow / cohort records остаются внутри `personal-context-storage` в `Data Storage and Privacy Layer`.
- Статусы вовлечённости рассчитываются в `Data Storage and Privacy Layer` по фактам активности; `Methodologist Web Panel` только отображает их.
- Правило минимальной группы для агрегированной аналитики: срезы меньше 5 человек не показываются в methodologist/client контуре.
- Персональные недельные и финальные итоги собираются через `personal-context-reasoning` в `AI Agent Backend Runtime` на основе данных из `Data Storage and Privacy Layer`.
