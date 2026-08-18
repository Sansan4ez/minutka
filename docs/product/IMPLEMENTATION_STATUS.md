# Статус перехода к исследовательскому корпусу

## Целевое решение

Принято [RFC исследовательского корпуса и клиентской карты автоматизации](../architecture/rfc-minutka-research-corpus-and-reporting.md). Переиспользуемая модель вынесена в [research-corpus-reporting-pattern.md](../architecture/research-corpus-reporting-pattern.md).

## Что работает сейчас

До implementation cutover runtime продолжает использовать:

- `privacy-v5`;
- anonymized activity dual-write;
- текущую ≥5-gated company export;
- старый consent process;
- conversation store без full research trace persistence.

Точный список — [skills-map.md](./skills-map.md).

## Что ещё не работает

- group-scoped `subject_key`;
- full trace store с input/context/model steps/tools/output;
- tenant-scoped evidence/evaluation export;
- subject-aware confidence reporting;
- активный `privacy-v6`;
- single canonical activity write без `anonymized_activities`.

## Правило cutover

Внешний пилот запускается только после задач `mnt-cycle-completion-4gd.12`–`.16` и integration gate. Draft [privacy-v6.html](./privacy-v6.html) не используется для consent до фактического переключения runtime.
