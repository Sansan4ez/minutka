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

## Canonical activity write

Runtime сохраняет одну subject-aware activity в `minutka_private.activities`. Запись содержит `subject_key`, локальную `activity_date` и, для activity из agent turn, `source_message_id`; research export и company reporting читают эту же каноническую запись. Старые anonymized dual-write, reporting table и отдельная retention-команда удалены.

## Правило внешнего запуска

Новый invite показывает `privacy-v6`; без принятого `privacy-v6` onboarding, диалог и research collection недоступны. Ранее принятое `privacy-v1`–`privacy-v5` требует re-consent. Внешний пилот проходит отдельный integration gate после canonical cleanup; privacy cutover активен, а `privacy-v5` остаётся неизменяемым архивом.
