# Продуктовые документы «Минутки»

## Текущий продукт

- [Final_Description.md](./Final_Description.md) — основной продуктовый baseline и пользовательские сценарии «Минутки»;
- [agent-minutka-brief.md](./agent-minutka-brief.md) — концепция, аудитории, двухнедельный цикл и границы продукта;
- [virtual-simulation.md](./virtual-simulation.md) — поведенческие сценарии программы;
- [dialogs-for-agent-minutka.md](./dialogs-for-agent-minutka.md) — референсы диалогов и тона;
- [skills-map.md](./skills-map.md) — фактически доступные возможности пилотной версии;
- [privacy-v5.html](./privacy-v5.html) — текущий неизменяемый снимок политики `privacy-v5`, на который ссылается `PRIVACY_POLICY_V5_URL` и двухслойный текст согласия;
- [privacy-v4.html](./privacy-v4.html) — архивный неизменяемый снимок предыдущей версии. Под уже принятой версией текст не меняется: изменение границ обработки означает новую версию и повторное согласие.

Архитектурные границы, включая мультитенантность, видимость участия и обезличенную отчётность, задаёт [RFC «Минутки»](../architecture/rfc-minutka-tenancy-and-reporting.md). При расхождении раннего продуктового текста с реализованной privacy-моделью действует RFC и канонический consent-текст.

## Унаследованный и фоновый контекст

- [product-brief-personal-ai-assistant.md](./product-brief-personal-ai-assistant.md) — бриф отдельного продукта, из репозитория которого клонирован runtime; не является брифом «Минутки»;
- [agents-architecture-of-course.md](./agents-architecture-of-course.md) — фоновая дорожная карта производства курса Института «Алгоритм», не продуктовый контракт пилота;
- `registry.json` — ранняя машина стадий legacy-реализации; живой runtime её не использует.

Документы legacy-реализации и переиспользуемого фундамента сохраняются с явным статусом `historical` в `docs/architecture/`.
