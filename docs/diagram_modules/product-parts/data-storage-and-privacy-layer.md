# Product Part: Data Storage and Privacy Layer

## Identity

| Field | Value |
| ----- | ----- |
| Part ID | `data-storage-and-privacy-layer` |
| Product Part | `Data Storage and Privacy Layer` |
| Purpose | Хранит личный контекст, историю, согласия, агрегированные и обезличенные сигналы, отчётные данные и аудит, удерживая правила доступа между персональными данными сотрудника и аналитикой компании. |

## Purpose

`Data Storage and Privacy Layer` отвечает за простую и понятную границу хранения: личная зона сотрудника, обезличенные агрегаты, согласия/audit и удаление личных данных. Физически это может быть одно хранилище, но на уровне продукта данные разделяются по ответственности и правилам доступа. Этот слой не выполняет AI-обезличивание сам: AI-assisted обезличивание остаётся в `AI Agent Backend Runtime`, а здесь сохраняются результаты и применяется доступ к ним.

## Owned Clusters

- На текущем уровне детализации кластеры не нужны: слой намеренно упрощён до standalone modules.

## Standalone Modules

| `module-id` | Responsibility |
| --- | --- |
| `personal-context-storage` | Хранит личный контекст, историю сотрудника и его привязку к программному потоку: портрет, предпочтения, рабочие паттерны, диалоговую историю, участие и данные, нужные для персональной помощи. |
| `aggregate-signal-storage` | Хранит обезличенные сигналы и агрегаты, подготовленные runtime, для персональных итогов сотрудника и безопасной аналитики компании. |
| `privacy-boundary` | Классифицирует структурированные поля по privacy-классам, готовит безопасные проекции для methodologist/client/audit/provider контуров и маскирует свободный текст перед внешними provider-вызовами. `employeeId` считается безопасным только как псевдоним, не связанный с ФИО или внешним идентификатором сотрудника. |
| `consent-and-audit-records` | Хранит согласия, факты показа privacy explanation, версии принятых правил и audit-события чувствительных действий без раскрытия содержания личных диалогов. |
| `personal-data-deletion` | Удаляет личный контекст и историю сотрудника по его запросу; уже созданные обезличенные агрегаты не пересчитываются и не удаляются автоматически. |

## Simple Relations

| From | To | Type | Label |
| --- | --- | --- | --- |
| `consent-and-audit-records` | `personal-context-storage` | config-ref | consent-aware-personal-storage |
| `personal-context-storage` | `personal-data-deletion` | sync-call | delete-personal-context-and-history |
| `aggregate-signal-storage` | `consent-and-audit-records` | async-event | aggregate-access-audit |
| `personal-context-storage` | `aggregate-signal-storage` | shared-data | private-summary-source |

## Assumptions / Open Questions

- Личный контекст и обезличенные агрегаты физически могут находиться в одном хранилище; Product Part разделяет их по ответственности и доступу, а не по выбранной технологии.
- Удаление по запросу сотрудника удаляет только личный контекст и историю; уже созданные обезличенные агрегаты не пересчитываются автоматически.
- Consent, privacy explanation и audit входят в этот Product Part, но зафиксированы одним упрощённым модулем `consent-and-audit-records`.
- AI-assisted обезличивание выполняется в `AI Agent Backend Runtime`; этот слой хранит уже подготовленные сигналы и агрегаты.
- Конкретная база данных, шифрование, retention-сроки и юридические детали хранения остаются будущими решениями и не фиксируются на уровне Diagram Modules.
- Program flow / cohort records на текущем уровне остаются внутри `personal-context-storage`, а не выделяются отдельным модулем.
- Статусы вовлечённости вроде `lagging` и `dropped off` считаются вычисляемыми на стороне storage-layer по фактам активности, а не по содержанию сообщений.
- Для видимой агрегированной аналитики действует правило минимальной группы: срезы меньше 5 человек не должны выдаваться в methodologist/client контур.
