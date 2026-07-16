# Стратегический анализ и архитектура рынка персональных AI-ассистентов

**Консолидированный отчёт по материалам `researches/`**  
**Дата среза исходных исследований:** 8–12 июля 2026 г.  
**Дата консолидации:** 13 июля 2026 г.

> Важно: рынок меняется ежемесячно. Цены, рейтинги, лимиты и названия тарифов ниже нормализованы по исследовательскому корпусу, но спорные данные приведены диапазонами или помечены как требующие перепроверки. Для коммерческого решения необходимо повторно открыть официальные pricing/help pages.

## 1. Резюме для руководителя

1. **Рынок перестал быть рынком чат-ботов.** Его новая единица ценности — не ответ, а делегированная работа: найти информацию, понять личный контекст, принять ограниченное решение, выполнить действие и оставить проверяемый след.
2. **Конкуренция идёт по доступу к контексту и правам на действие.** Качество базовой модели постепенно становится необходимым, но недостаточным условием. Более устойчивые преимущества дают OS-level context, почта, календарь, документы, social graph, purchase history, smart home, codebase и финансовые данные.
3. **Формируются два центра тяжести.** Первый — закрытые экосистемы Apple, Google, Microsoft, Amazon и Meta, выигрывающие дистрибуцией и доступом к данным. Второй — независимый agent layer, включая ChatGPT, Claude, Perplexity, вертикальные SaaS и self-hosted runtimes OpenClaw/Hermes.
4. **Ценовой якорь general-purpose premium остаётся около $20/мес.** Ниже формируется входной слой примерно $5–10; выше — professional/agentic tiers около $39–100 и heavy-use tiers около $200 и выше.
5. **Flat subscription уступает гибридному биллингу.** Агентные действия и тяжёлые reasoning-модели создают нестабильную себестоимость, поэтому распространяются credits, metered usage, overages, seat pricing и bundles.
6. **Самые доказанные сценарии — knowledge work и coding.** Письмо, суммаризация, поиск с цитатами, работа с документами, встречи и программирование дают понятный ROI. У бытовой автономии, финансовых действий и companions выше engagement, но также выше trust, safety и regulatory risk.
7. **Главный незакрытый продуктовый gap — контролируемая проактивность.** Пользователь хочет, чтобы ассистент помнил обещания, собирал задачи из коммуникаций и готовил действия заранее, но не хочет бесконтрольной автономии.
8. **Память становится инфраструктурой, а не отдельной функцией.** Нужны происхождение воспоминания, редактирование, срок жизни, переносимость, разделение личного и рабочего контекста и право полного удаления.
9. **Self-hosted agents создают новый слой рынка.** OpenClaw и Hermes показывают спрос на независимость от интерфейса одного LLM-вендора, локальное хранение, выбор модели и собственные skills. Пока это prosumer/developer market из-за сложности установки и security burden.
10. **Trust — главный ограничитель adoption.** Новые материалы Qwen усиливают этот вывод данными Pew и developer surveys: люди массово используют AI для информации и продуктивности, но заметно осторожнее относятся к критическим решениям и часто перепроверяют результат. Типовые причины оттока: непрозрачные лимиты, регрессии после обновлений, ложные обещания автономии, слабая память, неясные списания, privacy concerns и отсутствие понятного human override.
11. **Носимое AI-железо само по себе не создаёт moat.** Без сильной экосистемы, понятного job-to-be-done и устойчивой экономики continuous inference отдельные устройства проигрывают смартфонам и очкам крупных платформ.
12. **Наиболее привлекательная возможность для нового продукта:** cross-platform personal operations assistant — слой между почтой, календарём, мессенджерами, документами и задачами, работающий по модели `наблюдать → предложить → объяснить → получить подтверждение → выполнить → залогировать`.

## 2. Границы и методика консолидации

В общий анализ вошли семь основных отчётов — ChatGPT, Claude, Gemini, Perplexity, Qwen, NotebookLM и Grok — и дополнительный файл по OpenClaw/Hermes.

Новые отчёты не изменили базовую архитектуру рынка, но усилили три тезиса: (1) ценовой якорь около $20 остаётся устойчивым; (2) usage-based billing повышает недоверие и риск bill shock; (3) adoption растёт быстрее, чем готовность делегировать критические действия. При этом точные headline-цифры из Perplexity и часть продуктовых данных Qwen не включались без оговорок из-за высокой зависимости от SEO-источников, newsletters и единичных обзоров.

Использована следующая логика:

- **Высокая уверенность:** тезис повторяется минимум в трёх независимых отчётах или привязан к официальным страницам в одном из файлов.
- **Средняя уверенность:** тезис повторяется в двух отчётах, но детали расходятся, либо основан на качественном вторичном источнике.
- **Низкая уверенность:** точная цифра или прогноз встречается в одном отчёте, опирается на слабый источник или противоречит другим файлам.

Дополнительно применялся тест концентрации источников: многократные ссылки на один и тот же обзор не считались независимыми подтверждениями. Наличие кликабельной citation повышает трассируемость, но не повышает автоматически качество evidence.

Не делались жёсткие выводы из спорных точных данных — например, отдельных store ratings, модельных версий, региональных bundles, лимитов сообщений, неподтверждённых MAU/ARR/valuation и прогнозов рыночной доли.

## 3. Определение рынка

**Персональный AI-ассистент** — программный или аппаратно-программный продукт, который использует AI для понимания намерения пользователя, работы с личным или рабочим контекстом и выдачи ответа, рекомендации либо выполнения действия от имени пользователя.

Для зрелого ассистента недостаточно диалогового интерфейса. Его полный цикл состоит из шести функций:

1. **Sense:** получить сигнал — текст, голос, экран, файл, событие календаря, письмо, местоположение или данные датчика.
2. **Understand:** определить намерение и релевантный контекст.
3. **Remember:** найти или записать устойчивое знание о пользователе.
4. **Plan:** построить последовательность действий и оценить риски.
5. **Act:** использовать инструмент, API, браузер, приложение или устройство.
6. **Verify:** проверить результат, объяснить выполненное и сохранить audit trail.

Большинство продуктов 2023–2025 годов хорошо закрывали первые две функции. Конкуренция 2026 года смещается к памяти, действиям и верификации.

## 4. Архитектура рынка

### 4.1. Технологический стек

```text
┌──────────────────────────────────────────────────────────────┐
│  6. Trust & governance                                      │
│  Identity · consent · permissions · audit · rollback · cost │
├──────────────────────────────────────────────────────────────┤
│  5. Interface & distribution                                │
│  Chat · voice · OS · browser · IDE · messenger · wearable   │
├──────────────────────────────────────────────────────────────┤
│  4. Action layer                                             │
│  Apps · APIs · browser use · MCP/skills · smart home · pay  │
├──────────────────────────────────────────────────────────────┤
│  3. Personal context & memory                                │
│  Mail · calendar · files · contacts · history · preferences │
├──────────────────────────────────────────────────────────────┤
│  2. Agent runtime & orchestration                            │
│  Planning · routing · tool use · scheduling · verification  │
├──────────────────────────────────────────────────────────────┤
│  1. Models & infrastructure                                  │
│  LLM · speech · vision · embeddings · search · local/cloud  │
└──────────────────────────────────────────────────────────────┘
```

### 4.2. Где создаётся устойчивое преимущество

| Слой | Насколько коммодитизируется | Потенциальный moat |
|---|---|---|
| Базовые модели | Быстро | Scale, training data, inference economics, safety research |
| Agent runtime | Средне | Надёжность планирования, tool routing, recovery, reusable skills |
| Личный контекст | Медленно | История пользователя, data graph, permissions и переносимость |
| Action layer | Медленно | Глубокие write-integrations, партнёрства, transaction rights |
| Интерфейс/дистрибуция | Медленно | OS default, installed base, habit, voice/wearable presence |
| Trust/governance | Очень медленно | Репутация, compliance, explainability, auditability |

Стратегически наиболее защищены продукты, которые контролируют одновременно **дистрибуцию + контекст + действия + доверие**. Именно поэтому платформенные игроки обладают структурным преимуществом, а независимым компаниям нужна либо вертикальная глубина, либо нейтральный cross-platform layer.

## 5. Карта сегментов

### 5.1. Экосистемные ассистенты

**Примеры:** Apple Intelligence/Siri, Google Gemini, Microsoft Copilot, Amazon Alexa+, Meta AI.

**Преимущество:** встроенная дистрибуция, доступ к системным данным и возможность субсидировать AI через hardware, ads, cloud storage, office suites, commerce или Prime.

**Ограничение:** vendor lock-in, региональная фрагментация, privacy concerns и слабая совместимость с конкурирующими экосистемами.

**Стратегическая роль:** системный control plane персонального AI.

### 5.2. Универсальные chat/reasoning assistants

**Примеры:** ChatGPT, Claude, Gemini app, Grok.

**Преимущество:** широкая применимость, сильные модели, файлы, голос, код, research и быстрое добавление новых capabilities.

**Ограничение:** пользователь сам инициирует большинство задач; контекст часто фрагментирован; write-actions ограничены или требуют подтверждения.

**Стратегическая роль:** интеллектуальная рабочая среда и универсальный reasoning layer.

### 5.3. Research/search assistants

**Примеры:** Perplexity, Deep Research modes ChatGPT/Gemini/Claude.

**Преимущество:** web grounding, цитаты, скорость сбора и синтеза источников.

**Ограничение:** качество зависит от доступности веб-источников; citations не гарантируют корректность интерпретации; слабее personal action loop.

**Стратегическая роль:** answer engine и аналитический front end к открытым данным.

### 5.4. Вертикальные рабочие ассистенты и agent builders

**Примеры:** GitHub Copilot, Cursor, Notion AI, Grammarly, Motion, Granola, Otter.ai, Lindy.

**Преимущество:** находятся внутри workflow, используют специализированный контекст и доказывают ROI через время, качество или выручку. Motion закрывает динамическое планирование, Otter.ai — meeting capture, Lindy — конструирование фоновых агентов и интеграций.

**Ограничение:** рискуют быть поглощены функциями платформ; зависят от одного job-to-be-done или от устойчивости большого числа сторонних коннекторов. Для agent builders дополнительно критичны observability, approval policies и контроль стоимости каждого workflow.

**Стратегическая роль:** наиболее монетизируемый слой, если AI встроен в ежедневный инструмент. Agent builders формируют промежуточный рынок между готовым SaaS-ассистентом и self-hosted runtime.

### 5.5. Финансовые, образовательные и health assistants

**Примеры:** Cleo, Copilot Money, Duolingo Max, Khanmigo, Ada Health.

**Преимущество:** высокая предметная ценность, повторяемые сценарии, возможность специализированных данных и methodology moat.

**Ограничение:** regulatory liability, необходимость объяснимости, высокая цена ошибки и ограничение автономных действий.

**Стратегическая роль:** защищаемые вертикали, если продукт владеет не только интерфейсом, но и доменным workflow, лицензированием или финансовым продуктом.

### 5.6. Companions и эмоциональные ассистенты

**Примеры:** Replika, Character.AI, Nomi, Pi.

**Преимущество:** высокая частота использования, эмоциональное удержание, персонализация и creator ecosystems.

**Ограничение:** safety несовершеннолетних, dependency risk, нестабильность «личности» после обновлений, privacy и репутационные риски.

**Стратегическая роль:** отдельный engagement market, а не просто подвид productivity assistant.

### 5.7. Self-hosted autonomous agents

**Примеры:** OpenClaw, Hermes Agent.

**Преимущество:** выбор модели, собственный хостинг, persistent memory, skills, мессенджеры, отсутствие привязки к одному cloud UI.

**Ограничение:** setup, API keys, security hardening, skill supply-chain risk, стоимость непрерывного inference и отсутствие consumer-grade support.

**Стратегическая роль:** формирующийся personal agent runtime для developers, power users и privacy-conscious команд.

### 5.8. Ambient и wearable assistants

**Примеры:** Limitless/Pendant, Friend, Sonal, Sesame как voice-first adjacent product.

**Преимущество:** постоянное присутствие, capture контекста, low-friction voice interaction.

**Ограничение:** consent, battery, hardware reliability, continuous cloud costs и отсутствие уникальной ценности по сравнению со смартфоном/очками.

**Стратегическая роль:** интерфейс к assistant stack, но редко самостоятельная платформа.

## 6. Сводная таблица ключевых продуктов

Цены приведены как ориентиры по корпусу на июль 2026 года. Знак `≈` означает расхождение источников или региональную вариативность.

| Продукт | Сегмент | Ориентир цены | Основной сценарий | Главный актив | Основной риск | Уверенность |
|---|---|---:|---|---|---|---|
| Apple Intelligence / Siri | Экосистема | Включено в совместимые устройства | OS actions, writing, personal context | On-device/PCC, hardware distribution | Delays, device/region gating | Высокая по модели; средняя по текущим фичам |
| Google Gemini | Экосистема + general AI | Free; entry ≈$5–8; Pro ≈$20; higher tiers | Search, Workspace, Android, Live | Google data/services graph | Privacy, bundle complexity | Высокая по позиционированию; средняя по тарифам |
| Microsoft Copilot | Экосистема/work | Free; consumer bundle ≈$10–20; business add-on | Office, documents, meetings | M365/Graph distribution | Adoption friction, licensing complexity | Высокая |
| Amazon Alexa+ | Home/commerce | Prime bundle или ≈$20 | Smart home, shopping, household | Devices + retail graph | Geography, reliability, commerce bias | Высокая |
| Meta AI | Social ecosystem | Free | Social chat, creation, glasses | Massive distribution/social context | Advertising/privacy | Средняя |
| ChatGPT | General-purpose | Free; Go ≈$8; Plus $20; power ≈$100–200 | General work, coding, research, voice | Breadth, brand, product surface | Limits, cost, context fragmentation | Высокая по базовой сетке |
| Claude | General-purpose/work | Free; Pro $17–20; Max ≈$100–200 | Writing, reasoning, code, documents | Quality brand, code/document UX | Limits, fewer consumer integrations | Высокая |
| Perplexity | Research/search | Free; Pro $20; Max ≈$200 | Cited search and research | Search-first UX, model routing | Source access, IP and accuracy risk | Высокая |
| Grok | General/social | Free или X/SuperGrok tiers | Real-time X context, conversation | X distribution/data | Safety and reputation | Средняя |
| GitHub Copilot | Coding vertical | Free; Pro ≈$10; higher ≈$39–100 | IDE coding and agents | GitHub/IDE integration | Usage billing, code quality | Высокая |
| Cursor | Coding vertical | Free; Pro ≈$20; higher ≈$60–200 | Multi-file agentic coding | Codebase-native UX | Cost unpredictability, platform competition | Высокая по сегменту; средняя по цифрам |
| Notion AI | Knowledge-work vertical | Workspace subscription + possible credits | Notes, knowledge base, meetings, agents | Workspace context | Setup complexity, bundling | Высокая |
| Grammarly | Writing vertical | Free; paid ≈$12 | Rewriting, tone, correctness | Ubiquitous writing surface | Feature commoditization | Высокая |
| Motion | Planning vertical | ≈$19 annual equivalent / $34 monthly | Calendar and task scheduling | Dynamic rescheduling | Price, mobile UX, shallow communications context | Средняя |
| Otter.ai | Meeting vertical | Free; paid ≈$8–20 | Transcription, summaries, meeting follow-up | Meeting workflow and integrations | Crowded category, privacy/consent | Средняя |
| Lindy | Agent builder | Subscription + credits; точная сетка требует проверки | Background agents across business apps | No-code workflows and connector breadth | Connector fragility, cost and action safety | Низкая/средняя |
| Duolingo Max | Education | ≈$14 annual equivalent / $30 monthly; details vary | AI roleplay and speaking | Habit loop, pedagogy, characters | AI features becoming commodity | Средняя/низкая по текущему bundle |
| Cleo | Personal finance | ≈$6–15 | Budget chat, cash advance | Personality + financial products | Adversarial fees, trust | Высокая по модели |
| Copilot Money | Personal finance | ≈$13 monthly / $95 annual | Tracking, categorization, net worth | Premium UX/privacy | Apple/US lock-in | Высокая |
| Ada Health | Health | Free consumer; B2B-funded | Symptom assessment | Clinical knowledge/process | Liability, scope limitations | Средняя/высокая |
| Character.AI | Companion/roleplay | Free; c.ai+ ≈$10 | Roleplay and creator characters | UGC network | Safety, ads, memory, volatile ratings | Высокая по модели; низкая по rating |
| Replika | Companion | Free; paid tiers ≈$8–30 | Long-term emotional companion | Relationship continuity/avatar | Memory inconsistency, safety/privacy | Средняя |
| Sesame | Voice-first | Free preview в корпусе | Natural conversation | Voice quality and turn-taking | Early-stage product, unclear monetization | Средняя |
| OpenClaw | Self-hosted agent runtime | Open source + hosting/model usage | Personal automation via tools/channels | Open ecosystem, model choice | Security, setup, cost control | Средняя |
| Hermes Agent | Self-hosted agent runtime | Open source + infrastructure | Reusable/self-improving skills | Persistent learning/skills thesis | Early maturity, security, evidence gaps | Низкая/средняя |
| Limitless | Ambient memory | Исторически hardware + subscription; статус изменился | Conversation capture and recall | Ambient memory UX | Privacy, acquisition/status, cloud economics | Низкая/средняя |
| Friend | Wearable companion | Hardware ≈$99–129 | Proactive companion messages | Novel form factor/no subscription promise | Hardware gap, server economics, privacy | Средняя |
| Sonal | Health/cognitive wearable | Preorder/hardware + future subscription | Cognitive support and caregiver reports | Narrow clinical-adjacent JTBD | Pre-launch evidence, consent, regulation | Низкая |

## 7. Конкурентная динамика

### 7.1. Платформы против независимых игроков

Платформенные компании получают четыре структурных преимущества:

- default placement;
- privileged context;
- системные permissions;
- способность субсидировать inference из других бизнесов.

Независимый игрок может ответить только одним из трёх способов:

1. **Вертикальная глубина:** лучшее решение конкретного workflow, как coding или finance.
2. **Кросс-платформенная нейтральность:** единый слой поверх нескольких экосистем.
3. **Privacy/control:** self-hosted, local-first или пользовательское владение памятью.

### 7.2. Модель как commodity, workflow как moat

Базовую генерацию текста, суммаризацию и чат копируют быстро. Более устойчивы:

- integrations на запись, а не только чтение;
- накопленный user context;
- reusable workflow/skills;
- domain-specific evaluation;
- compliance и liability handling;
- distribution inside a habitual surface.

Поэтому GitHub Copilot, Cursor, Notion, Grammarly, Cleo и Ada следует сравнивать не только по модели, а по тому, насколько глубоко они встроены в работу.

### 7.3. От ответа к делегированию

Эволюция продукта выглядит так:

```text
Q&A → создание контента → работа с файлами → research → tool use
→ multi-step agent → scheduled/proactive agent → delegated operator
```

На каждом шаге растут одновременно ценность и риск. Переход к delegated operator невозможен без permission model, подтверждений, ограничений расходов, журналов и recovery.

## 8. Ценообразование и экономика

### 8.1. Ценовые кластеры

| Кластер | Ориентир | Типичные продукты | Логика |
|---|---:|---|---|
| Free/included | $0 | Ecosystem assistants, free chat tiers, Meta AI | Distribution, upsell, ads, hardware, data/ecosystem value |
| Entry | $4–10 | ChatGPT Go, low-tier Google AI, Khanmigo, c.ai+, Cleo | Конверсия массовой аудитории и снятие базовых лимитов |
| Mainstream premium | $17–20 | ChatGPT Plus, Claude Pro, Perplexity Pro, Google AI Pro | Устойчивый consumer/prosumer anchor |
| Vertical productivity | $10–40 | GitHub Copilot, Grammarly, Notion, Motion, Copilot Money | Цена оправдывается конкретным workflow и ROI |
| Professional/agentic | $39–100 | Coding tiers, Claude Max entry, higher bundles | Высокие лимиты, background agents, professional usage |
| Heavy-use | $200+ | Top chat/search/coding tiers | Покрытие дорогого inference и непрерывной работы |
| Enterprise | Per-seat + usage | M365, GitHub, Notion, API/agents | Governance, security, admin, SLA, audit |

### 8.2. Доминирующие модели монетизации

1. **Freemium subscription** — базовая модель general-purpose и companion products.
2. **Bundle economics** — Office, storage, Prime, hardware, social ecosystem.
3. **Subscription + usage/credits** — наиболее вероятная модель для agentic workloads.
4. **Seat-based B2B** — productivity и enterprise assistants.
5. **API/licensing** — фундаментальные модели и инфраструктура.
6. **Ads** — возврат в free tiers и social/companion products.
7. **Transaction/financial economics** — commerce commissions, cash advance, cards, referrals.
8. **Hardware + service** — smart home и wearables.
9. **Open source + infrastructure** — self-hosted agents, managed hosting, model/API spend, enterprise support.

### 8.3. Почему usage-based слой неизбежен

У чат-ответа ограниченная и относительно предсказуемая себестоимость. Агентная задача может включать десятки model calls, браузер, поиск, retries и верификацию. Поэтому flat unlimited pricing создаёт adverse selection: самые активные пользователи становятся наиболее убыточными.

Для хорошего agent product нужны:

- предварительная оценка стоимости;
- дневной/месячный budget cap;
- real-time usage meter;
- выбор режима «экономный / стандартный / максимальная надёжность»;
- подтверждение дорогих действий;
- post-task cost breakdown.

## 9. Основные jobs-to-be-done

| JTBD | Зрелость рынка | Готовность платить | Комментарий |
|---|---|---|---|
| Письмо, редактирование, суммаризация | Высокая | Средняя | Быстро коммодитизируется, выигрывает distribution |
| Поиск и research с цитатами | Высокая | Средняя/высокая | Ценность растёт с проверяемостью и качеством источников |
| Coding | Очень высокая | Высокая | Лучший доказанный профессиональный ROI |
| Документы, meetings, knowledge base | Высокая | Высокая в B2B | Сильный moat через workspace context |
| Транскрипция и follow-up встреч | Высокая | Средняя/высокая в B2B | Отдельный продукт быстро коммодитизируется; ценность смещается к action items и CRM/task execution |
| Почта, календарь, задачи | Средняя | Высокая при надёжности | Главный кандидат на proactive agent |
| Smart home и household coordination | Средняя | Средняя | Нужна hardware/ecosystem distribution |
| Финансовый контроль | Средняя | Средняя/высокая | Trust и regulation ограничивают действия |
| Обучение | Средняя | Низкая/средняя | Нужна pedagogy, habit loop, а не только LLM |
| Health guidance | Средняя | B2B выше B2C | Требуются clinical evidence и scope control |
| Companionship/roleplay | Высокая engagement, низкая trust maturity | Средняя | Сильное удержание, высокий safety risk |
| Ambient memory | Ранняя | Не доказана | Privacy и hardware economics остаются барьерами |
| Полностью автономный personal operator | Ранняя | Потенциально высокая | Ограничен reliability, permissions и liability |

## 10. Повторяющиеся пользовательские боли

1. **Лимиты непонятны до покупки.** Пользователь не знает, сколько тяжёлых запросов или агентных задач реально получит.
2. **Качество меняется без контроля пользователя.** Обновление модели может изменить стиль, память или поведение.
3. **Память либо слабая, либо непрозрачная.** Неясно, что сохранено, откуда это взялось и как удалить.
4. **Маркетинг обещает больше, чем production reliability.** Особенно болезненно для OS actions и автономных агентов.
5. **Интеграции часто read-only.** Ассистент умеет найти письмо, но не завершить workflow.
6. **Cross-platform context распадается.** Личные и рабочие данные живут в разных системах.
7. **Usage billing вызывает bill shock.** Особенно в coding и background agents.
8. **Privacy controls сложны.** Opt-out, training policy, retention и third-party tools трудно понять.
9. **Нет нормального recovery.** Ошибочное действие трудно отменить.
10. **Цитата воспринимается как гарантия, хотя ею не является.** Research-ассистент может сослаться на реальную страницу, которая не подтверждает масштаб вывода или противоречит синтезу.
11. **Companion products нарушают continuity.** Изменение фильтров или модели воспринимается как потеря отношений.

Новые источники позволяют точнее сформулировать парадокс рынка: **utility уже высокая, calibrated trust — низкий**. Пользователь готов поручить черновик, поиск или суммаризацию, но существенно менее готов разрешить отправку, покупку, медицинское или финансовое решение. Следовательно, рост использования нельзя считать эквивалентом готовности к автономии.

## 11. Главные gaps рынка

### 11.1. Personal operations layer

Сегодня коммуникации, обещания и задачи разорваны между Gmail/Outlook, Slack/Telegram/WhatsApp, календарём, заметками и task managers. Рынку не хватает нейтрального слоя, который:

- извлекает обязательства и дедлайны;
- устраняет дубликаты;
- связывает задачу с исходным сообщением;
- предлагает слот в календаре;
- напоминает с учётом контекста;
- готовит ответ или действие;
- выполняет его только в рамках policy пользователя.

### 11.2. User-owned memory

Память должна быть отдельным продуктовым объектом:

- видимый memory ledger;
- источник и дата каждого факта;
- confidence и срок жизни;
- редактирование и запрет на использование;
- namespaces: personal, family, work, health;
- export/import между моделями;
- local encryption и selective sync.

### 11.3. Safe delegation

Большинство продуктов предлагают либо реактивный чат, либо слишком широкий agent mode. Нужен промежуточный режим:

```text
наблюдать → предложить → показать план и стоимость
→ запросить подтверждение → выполнить → проверить → дать undo
```

### 11.4. Household assistant вне одной экосистемы

Семья часто использует смешанный стек Apple/Android, разные календари, smart-home vendors и магазины. Независимый household graph может объединить:

- расписания членов семьи;
- покупки и запасы;
- домашние задачи;
- поездки;
- сервисное обслуживание;
- безопасные роли детей и взрослых.

### 11.5. Verifiable answer and action layer

Perplexity и Qwen независимо усиливают спрос на trust layer, но продуктовая возможность шире обычного fact-checking API. Нужен слой, который:

- проверяет, действительно ли источник подтверждает конкретный claim;
- различает первоисточник, качественную аналитику, пользовательский отзыв и SEO-обзор;
- показывает confidence и расхождения между источниками;
- верифицирует результат действия, а не только текст ответа;
- блокирует выполнение, если evidence или execution state недостаточны.

Такой слой особенно ценен в research, procurement, finance, health и enterprise workflows. Его moat создаётся не общей «проверкой фактов», а доменными evaluations, provenance graph и журналом решений.

### 11.6. Privacy-first agent for non-technical users

OpenClaw/Hermes демонстрируют спрос, но требуют технической компетенции. Возможность — consumer-grade appliance или managed local-first service с:

- one-click deployment;
- isolated connectors;
- signed skills;
- least-privilege permissions;
- automatic updates;
- readable security dashboard.

## 12. Риски

### 12.1. Product and technical

- hallucinated actions;
- prompt injection через письма, документы и веб;
- skill/plugin supply-chain attacks;
- memory poisoning;
- cascading multi-agent failures;
- silent partial completion;
- runaway inference costs.

### 12.2. Privacy and security

- избыточные OAuth permissions;
- постоянная запись окружения;
- смешение personal/work data;
- обучение на чувствительном контенте;
- компрометация long-term memory;
- отсутствие полного удаления и data portability.

### 12.3. Regulatory and ethical

- healthcare/financial advice liability;
- age assurance для companions;
- dependency и manipulation risk;
- consent окружающих для ambient recording;
- региональные ограничения AI Act, DMA и privacy laws;
- disclosure спонсируемых рекомендаций и commerce bias.

### 12.4. Business

- platform bundling уничтожает standalone willingness to pay;
- model/API supplier dependency;
- gross-margin pressure от agents;
- низкий switching cost для generic chat;
- high support burden после ошибочных действий;
- репутационный ущерб от одного safety incident.

## 13. Стратегические сценарии на 12–24 месяца

### Сценарий A: Platform consolidation

OS и suite vendors превращают assistants в default layer. Независимые general chat products сохраняются, но большая часть consumer actions проходит через Apple/Google/Microsoft/Amazon.

**Вероятность:** высокая.  
**Победители:** владельцы ОС, productivity suites и commerce graphs.  
**Риск стартапам:** feature absorption.

### Сценарий B: Neutral agent layer

Пользователи выбирают независимый assistant, который маршрутизирует запросы между моделями и подключается к нескольким экосистемам.

**Вероятность:** средняя.  
**Победители:** cross-platform agents, aggregators, OpenClaw-like runtimes.  
**Условие:** безопасные write-integrations и portable memory.

### Сценарий C: Vertical dominance

General assistants остаются front door, но ценность и монетизация концентрируются в coding, finance, health, education и work knowledge.

**Вероятность:** высокая.  
**Победители:** продукты с domain data, workflow и measurable outcomes.

### Сценарий D: Trust backlash

Крупный incident с автономным действием, companion safety или ambient recording замедляет adoption и усиливает regulation.

**Вероятность:** средняя/высокая.  
**Победители:** products with conservative autonomy, local processing and strong auditability.

## 14. Рекомендованная продуктовая позиция

Если задача — создать новый персональный AI-ассистент, наиболее защищаемая позиция выглядит так:

> **Контролируемый personal operations agent для knowledge workers и небольших команд, нейтральный к моделям и экосистемам, с пользовательской памятью и прозрачным выполнением действий.**

### 14.1. Целевая аудитория

- founders и руководители небольших компаний;
- независимые консультанты;
- project/product managers;
- специалисты с большим объёмом коммуникаций;
- power users, использующие несколько LLM и SaaS.

### 14.2. Core job

«Не дай мне потерять договорённости и возьми на себя безопасную координацию между коммуникациями, календарём, задачами и документами».

### 14.3. MVP

1. Connectors: Gmail/Outlook, Google/Microsoft Calendar, Slack/Telegram, Notion/Drive.
2. Commitment extraction с обязательной ссылкой на источник.
3. Unified daily brief: commitments, deadlines, waiting-for, risks.
4. Предложение calendar blocks и drafts.
5. Approval inbox для всех write-actions.
6. Memory ledger с edit/delete/export.
7. Claim/source verifier для research и generated briefs: показывает, какой источник подтверждает каждый существенный вывод.
8. Audit log, post-action verification и undo.
9. Budget controls для model/tool usage.

### 14.4. Что не включать в первый релиз

- автономные платежи;
- health/therapy positioning;
- фоновую запись всего окружения;
- unrestricted browser agent;
- автоматическую отправку внешних сообщений без подтверждения;
- эмоциональную зависимость как retention mechanic.

### 14.5. Монетизация

Рекомендуемая схема:

- Free/Trial: ограниченное число connectors и read-only brief;
- Individual: **$15–20/мес**;
- Pro: **$39–59/мес** с background jobs и повышенными лимитами;
- Team: seat fee + shared workflows;
- Usage: прозрачные credits только для дорогих агентных задач;
- Optional local/private deployment для premium/enterprise.

### 14.6. Метрики

Главная метрика — не число сообщений.

- commitments correctly captured;
- tasks completed with no correction;
- approved-action success rate;
- time saved per active user;
- false-positive task rate;
- undo/rollback rate;
- cost per completed workflow;
- weekly retained delegated workflows;
- trust score / permission expansion rate.

## 15. Принципы продукта-победителя

1. **Context before intelligence:** сначала правильные данные, потом сложная модель.
2. **Proposal before autonomy:** сначала рекомендация и план, затем делегирование.
3. **Source-linked memory:** любое воспоминание имеет происхождение.
4. **Least privilege by default:** connector получает минимальные права.
5. **Human-readable audit:** пользователь понимает, что и почему произошло.
6. **Predictable cost:** цена действия видна до выполнения.
7. **Model neutrality:** сильная модель выбирается под задачу, а не диктует весь продукт.
8. **Graceful degradation:** при сбое агент не делает опасное предположение.
9. **Portable identity and memory:** данные пользователя не должны быть заложниками одного провайдера.
10. **Outcome over conversation:** продукт измеряет завершённую работу, а не длину чата.

## 16. Итоговые выводы

- Рынок движется к **delegation layer**, но массовая автономия ещё не достигла необходимого уровня доверия.
- Победители будут контролировать не только модель, но и **контекст, permissions, workflow и verification**.
- Платформенные игроки доминируют в системном слое; независимые — в вертикалях, нейтральной оркестрации и privacy-first архитектуре.
- Около $20/мес остаётся главным B2C-якорем; агентность толкает рынок к tiers и usage billing.
- Coding и knowledge work — самые зрелые рынки; finance, health, companions и ambient AI требуют более строгой governance.
- OpenClaw и Hermes подтверждают появление self-hosted personal agent runtime, но security и usability пока ограничивают массовый спрос.
- Лучшее окно для нового продукта — **cross-platform, user-controlled, source-grounded personal operations assistant** с постепенным расширением автономии.

## 17. Основа отчёта

Консолидация выполнена по следующим файлам:

- `researches/research-pers-assist-chatgpt.md`
- `researches/research-pers-assist-claude.md`
- `researches/research-pers-assist-gemini.md`
- `researches/research-perplexity.md`
- `researches/research-qwen.md`
- `researches/research-pers-assist-NotebookLM.md`
- `researches/research-pers-assist-Grok.md`
- `researches/research-about-OpenClaw-Hermes.md`

Наиболее надёжными для структуры и синтеза признаны отчёты ChatGPT и Claude. Perplexity использован для обновления сравнительных таблиц, pricing/monetization patterns и повторяющихся жалоб, но его headline-метрики исключены без независимой проверки. Qwen использован для усиления trust thesis, agent-builder и meeting-assistant сегментов и поиска прямых ссылок; повторяющиеся ссылки на один обзор не считались независимыми свидетельствами. Gemini и NotebookLM использованы для расширения product long list; Grok — для проверки верхнеуровневого консенсуса; OpenClaw/Hermes — для категории self-hosted agents.
