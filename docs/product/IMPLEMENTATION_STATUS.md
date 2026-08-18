# Статус перехода к исследовательскому корпусу

## Целевое решение

Принят [RFC исследовательского корпуса и клиентской карты автоматизации](../architecture/rfc-minutka-research-corpus-and-reporting.md). Переиспользуемая модель вынесена в [research-corpus-reporting-pattern.md](../architecture/research-corpus-reporting-pattern.md).

## Что работает сейчас

Runtime использует новый research contour:

- случайный group-scoped `subject_key`;
- full execution traces с tenant/subject/message correlation;
- tenant-scoped corpus export и human evaluation cases;
- subject-aware canonical reporting с confidence и отдельным client DTO;
- активный immutable consent snapshot `privacy-v6`;
- ручной retention/purge по company/group/subject scope и report recompute как заявленная операторская процедура.

Точный пользовательский список — [skills-map.md](./skills-map.md).

## Что ещё не удалено

До cleanup-задачи `mnt-cycle-completion-4gd.16` runtime сохраняет legacy anonymized activity dual-write и старую company-anonymized purge command. Эти записи не являются источником canonical research export или client report и не определяют active consent. Следующий срез удаляет:

- `minutka_reporting.anonymized_activities`;
- `AnonymizedActivityRecord` и `saveActivityPair`;
- старый reporting retention path и его specs/runbook.

## Правило внешнего запуска

Новый invite показывает `privacy-v6`; без принятого `privacy-v6` onboarding, диалог и research collection недоступны. Ранее принятое `privacy-v1`–`privacy-v5` требует re-consent. Внешний пилот проходит integration gate только после cleanup-задачи `.16`; сам privacy cutover уже активен и `privacy-v5` остаётся неизменяемым архивом.
