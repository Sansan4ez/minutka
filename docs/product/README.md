# Продуктовые документы «Минутки»

## Текущий продукт

- [Final_Description.md](./Final_Description.md) — основной продуктовый baseline: ценность, роли, двухнедельный цикл, corpus, evidence и client report;
- [agent-minutka-brief.md](./agent-minutka-brief.md) — краткий продуктовый бриф, гипотеза и критерии пилота;
- [skills-map.md](./skills-map.md) — только фактически доступные возможности текущего runtime;
- [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) — текущий active research/privacy-v6 contour и canonical activity/reporting boundary;
- [evidence-pack-and-client-report-template.md](./evidence-pack-and-client-report-template.md) — принятые internal/client Markdown и JSON-шаблоны, confidence policy и ручной review/publish flow; пока не автоматизированы;
- [virtual-simulation.md](./virtual-simulation.md) — ранний сценарный baseline; требует синхронизации при реализации нового RFC и не переопределяет текущие границы;
- [dialogs-for-agent-minutka.md](./dialogs-for-agent-minutka.md) — референсы диалогов и тона;
- [privacy-v6.html](./privacy-v6.html) — активный неизменяемый policy snapshot первого внешнего пилота, на который ссылается `PRIVACY_POLICY_V6_URL`;
- [privacy-v5.html](./privacy-v5.html) — архивный неизменяемый snapshot внутренних тестов;
- [privacy-v4.html](./privacy-v4.html) — архивный неизменяемый snapshot.

Архитектурные границы задаёт [RFC исследовательского корпуса и клиентской карты автоматизации](../architecture/rfc-minutka-research-corpus-and-reporting.md). Переиспользуемая модель для других продуктов описана в [research-corpus-reporting-pattern.md](../architecture/research-corpus-reporting-pattern.md).

Старый [RFC мультитенантного контура и обезличенной отчётности](../architecture/rfc-minutka-tenancy-and-reporting.md) оставлен как провенанс tenant-модели, но superseded в части reporting/privacy. Активный consent process, `privacy-v6`, canonical research export и отдельный client DTO описывают живое поведение.

## Унаследованный и фоновый контекст

- [product-brief-personal-ai-assistant.md](./product-brief-personal-ai-assistant.md) — бриф отдельного продукта, из репозитория которого клонирован runtime; не является брифом «Минутки»;
- [agents-architecture-of-course.md](./agents-architecture-of-course.md) — фоновая дорожная карта производства курса Института «Алгоритм», не продуктовый контракт пилота;
- `registry.json` — ранняя машина стадий legacy-реализации; живой runtime её не использует и она не является текущим requirement catalog.

Документы legacy-реализации и переиспользуемого фундамента сохраняются с явным статусом `historical` в `docs/architecture/`.
