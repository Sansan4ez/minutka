# Product Part: Telegram Bot Shell

> **Статус: historical.** Диаграмма описывает legacy-концепцию «Минутки» и не является архитектурой пилота. Веб-панель методолога — не-цель пилота; справочники, участие и выгрузки обслуживаются через SQL/CLI по [RFC §7](../../architecture/rfc-minutka-tenancy-and-reporting.md#7-не-цели-и-когда-пересмотреть).


## Identity

| Field | Value |
| ----- | ----- |
| Part ID | `telegram-bot-shell` |
| Product Part | `Telegram Bot Shell` |
| Purpose | Даёт сотруднику основной вход в продукт через Telegram: онбординг, ежедневные касания, голосовые и текстовые сообщения, личные итоги, настройки и управление личными данными. |

## Purpose

`Telegram Bot Shell` — основная поверхность сотрудника в Minutka. Через неё сотрудник входит в программу по индивидуальной ссылке, проходит онбординг, видит privacy explanation, выбирает стиль общения, отправляет голосовые и текстовые сообщения, получает ответы AI-партнёра, просматривает личный контекст и персональные итоги, меняет настройки и запускает удаление личных данных. Shell не владеет AI-логикой, хранением или отчётностью: он принимает действия сотрудника, показывает результаты и передаёт смысловую обработку в другие Product Parts.

## Owned Clusters

- На текущем уровне детализации кластеры не нужны: Telegram shell намеренно упрощён до standalone modules.

## Standalone Modules

| `module-id` | Responsibility |
| --- | --- |
| `onboarding-and-consent-surface` | Проводит сотрудника по индивидуальной Telegram-ссылке, объяснению приватности, подтверждению участия, стартовым вопросам и первичному выбору стиля общения. |
| `daily-dialogue-surface` | Даёт сотруднику ежедневную поверхность для morning planning, optional midday check-in, evening reflection, in-the-moment help, голосового/текстового ввода и показа ответа Minutka. |
| `personal-area-and-summary-view` | Показывает сотруднику его личный портрет, рабочие паттерны, недельные итоги, финальный персональный отчёт и другие приватные summary только для него. |
| `preferences-and-feedback` | Позволяет сотруднику менять стиль общения/persona, базовые настройки и давать быструю оценку ответам Minutka. |
| `data-control-surface` | Даёт сотруднику понятное действие удаления личного контекста и истории, а также показывает пользовательские privacy-действия без раскрытия данных внешним ролям. |

## Simple Relations

| From | To | Type | Label |
| --- | --- | --- | --- |
| `onboarding-and-consent-surface` | `daily-dialogue-surface` | async-event | participant-ready |
| `preferences-and-feedback` | `daily-dialogue-surface` | config-ref | selected-persona-and-feedback |
| `daily-dialogue-surface` | `personal-area-and-summary-view` | async-event | personal-progress-available |
| `personal-area-and-summary-view` | `data-control-surface` | config-ref | privacy-and-context-control |

## Assumptions / Open Questions

- `Telegram Bot Shell` является shell, а не всей логикой продукта: AI-ответы, reasoning по личному контексту, извлечение сигналов и AI-assisted обезличивание принадлежат `AI Agent Backend Runtime`.
- Личный контекст, история, согласия, audit, агрегаты и удаление как фактическая операция хранения принадлежат `Data Storage and Privacy Layer`; Telegram shell только показывает сотруднику поверхность этих действий.
- Персональные недельные и финальные итоги агрегируются из `Data Storage and Privacy Layer` и показываются сотруднику через `personal-area-and-summary-view`.
- Мягкие напоминания могут инициироваться из `Methodologist Web Panel`, но сотрудник получает их через Telegram shell без раскрытия методологу личных сообщений, задач или эмоций.
- На старте отдельного мобильного приложения нет: сотрудническое взаимодействие происходит через Telegram.
- Точный Telegram UI, команды, кнопки, deep-link формат и транспорт между Product Parts не фиксируются на уровне Diagram Modules.
