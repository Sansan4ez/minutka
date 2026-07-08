# Product Part: AI Agent Backend Runtime

## Identity

| Field | Value |
| ----- | ----- |
| Part ID | `ai-agent-backend-runtime` |
| Product Part | `AI Agent Backend Runtime` |
| Purpose | Интерпретирует сообщения сотрудника, управляет AI-диалогом, использует личный контекст, извлекает и обезличивает сигналы, а также обращается к внешним AI/STT-зависимостям через безопасную runtime-границу. |

## Purpose

`AI Agent Backend Runtime` отвечает за поведение Minutka как AI-партнёра. Он принимает смысл входящих сообщений из Telegram shell, удерживает разговор в допустимой рабочей теме, применяет выбранный стиль общения, использует личный контекст сотрудника, формирует ответ, обновляет смысловые наблюдения и готовит обезличенные сигналы для хранения и дальнейшей аналитики. Внешние AI/STT-провайдеры не являются отдельным Product Part; runtime владеет только границей безопасного обращения к ним.

## Owned Clusters

- На текущем уровне детализации кластеры не нужны: runtime намеренно упрощён до standalone modules.

## Standalone Modules

| `module-id` | Responsibility |
| --- | --- |
| `employee-dialogue-orchestration` | Управляет AI-диалогом с сотрудником: понимает сообщение, проверяет допустимую тему, применяет тон/персону и формирует ответ. |
| `personal-context-reasoning` | Использует личный контекст сотрудника, обновляет смысловые наблюдения и собирает персональные недельные/финальные итоги из данных storage-layer. |
| `signal-extraction-and-anonymization` | Выделяет структурированные сигналы из диалога и личного контекста, затем выполняет AI-assisted обезличивание перед передачей результатов в storage-layer. |
| `ai-and-speech-provider-access` | Выполняет единый runtime-доступ к внешним или отдельно размещённым STT/LLM-провайдерам и применяет подготовку чувствительных данных перед такими вызовами. |

## Simple Relations

| From | To | Type | Label |
| --- | --- | --- | --- |
| `employee-dialogue-orchestration` | `personal-context-reasoning` | shared-data | employee-context-for-response |
| `employee-dialogue-orchestration` | `ai-and-speech-provider-access` | sync-call | speech-or-language-processing |
| `personal-context-reasoning` | `signal-extraction-and-anonymization` | async-event | context-and-dialogue-signals |
| `signal-extraction-and-anonymization` | `ai-and-speech-provider-access` | sync-call | anonymization-support |

## Assumptions / Open Questions

- Runtime упрощён до четырёх standalone modules; прежние детали вроде проверки темы, тона, понимания сообщения и генерации ответа считаются частями `employee-dialogue-orchestration`, а не отдельными Product Part boundaries.
- `ai-and-speech-provider-access` намеренно остаётся одним модулем для STT и LLM-доступа, потому что на текущем уровне важна общая граница безопасного обращения к внешним AI-зависимостям.
- Извлечение смысловых сигналов и AI-assisted обезличивание объединены в `signal-extraction-and-anonymization`, потому что это единая runtime-подготовка данных перед хранением и аналитикой.
- Хранение личного контекста, обезличенных результатов, отчётных данных, удаления и audit принадлежит `Data Storage and Privacy Layer`.
- Персональные недельные и финальные итоги сотрудника агрегируются из `Data Storage and Privacy Layer`; runtime не владеет ими как отдельным reporting-контуром на этом уровне диаграммы.
- Runtime не должен открывать методологу или компании индивидуальные разговоры, задачи, личный портрет или эмоциональное состояние сотрудника; он может передавать дальше только подготовленные сигналы через privacy/storage boundary.
- Mastra является выбранной технической основой runtime, но на этом уровне диаграммы Product Part остаётся концептуальной границей, а не перечнем конкретных файлов Mastra.
- Расписание morning/midday/evening prompts и другая workflow-логика оставлены будущей зоной `AI Agent Backend Runtime`; на текущем уровне они не выделяются в отдельный модуль.
- Составление персональных недельных и финальных итогов сотрудника относится к `personal-context-reasoning`, которое опирается на данные из `Data Storage and Privacy Layer`.
