# Калибровка usage и стоимости пилота

Этот runbook фиксирует baseline `prs-ip0.7` и процедуру ежемесячной перекалибровки. Счётчик `minutka_private.usage` хранит только метаданные токенов; текст запросов и ответов туда не попадает.

## Зафиксированный baseline

Продовый срез до изменений (31.07–02.08, основной chat-agent):

| метрика | 31.07–01.08 (issue baseline) | 31.07–02.08 (перед изменениями) |
|---|---:|---:|
| ходы | 62 | 87 |
| входные токены | 1 454 231 | 2 457 487 |
| выходные токены | 17 856 | 25 583 |
| средние входные токены на ход | 23 455 | 28 247 |
| максимум входных токенов | 77 453 | 77 453 |
| оценка при `$5/M input`, `$30/M output` | $7.81 | $13.05 |

**Исторический baseline снят по колонке с токенами последнего LLM-шага и как per-turn baseline недействителен.** Начиная с `prs-ip0.10`, runtime выбирает один согласованный источник за весь ход: `result.totalUsage`, затем сумму `steps[].usage`, затем одношаговый `result.usage`. Таблица выше остаётся только исторической нижней границей неизвестного размера; для решений о ceiling'ах и ставках нужен новый post-deployment срез по процедуре ниже.

Срез 31.07–02.08 показывает две группы ходов: обычные ответы около 15–18k input и tool-loop ходы до 71–77k. Поэтому после deployment основной operational signal — `assistant_turn_usage`: одна metadata-only строка на каждый LLM-вызов с `source`, `inputTokens`, `outputTokens`, `llmSteps`, `requestId` и, если провайдер сообщил, `cachedInputTokens`. У строки `source='chat'` дополнительно есть фактические Unicode-размеры включённых секций в `contextSourceCharacters`.

После сокращения manual ceiling живой продуктовый post-change замер выполняется по процедуре ниже: для полного live owner turn нужны transport credentials и он намеренно не генерируется автоматически из задачи. До deployment зафиксирован воспроизводимый provider/Mastra probe: 10 316 input tokens на одношаговый вызов, из них 9 984 cached на повторе. Цель первого живого прогона — среднее `<= 16 000` входных токенов на ход при сохранённом продуктовом сценарии. Это не hard cap; если цель не достигнута, soft limit не блокирует запросы, а оператор повторяет разбор по шагам.

## Решение по prompt caching

Текущий endpoint `OPENAI_BASE_URL=http://127.0.0.1:8317/v1`, модель `11qiw/gpt-5.5`, поддерживает OpenAI Responses prompt caching. Capability probe 02.08.2026 с идентичным префиксом в 10 108 input tokens дал:

| запрос | cached input tokens |
|---:|---:|
| первый | 0 |
| второй | 9 984 |
| третий | 9 984 |

Повторная проверка через установленный Mastra/AI SDK после включения provider options (10 316 input tokens) дала `0 → 9 984 → 9 984` cached tokens, то есть настройка доходит через фактический runtime stack.

Caching включён через стабильные OpenAI provider options `promptCacheKey=personal-assistant-v1` и `promptCacheRetention=24h`. Кэш не меняет prompt и не является response cache: провайдер переиспользует только exact-match prefix. Проверять реальный эффект нужно по `cachedInputTokens`; отсутствие этого поля означает «провайдер не сообщил», а не доказанный cache miss.

## Ревизия статического префикса

Фактически загруженный `agent_manual` вместе с максимальной response policy занимает 22 545 Unicode characters. Предыдущий ceiling 33 000 оставлял 10k неиспользуемого запаса и позволял незаметно раздувать самый дорогой статический источник. Canonical ceiling снижен до 24 000: текущий trusted manual помещается, а дальнейший рост раньше остановит startup/spec.

## Прайс и soft limit

Локальный CLIProxyAPI направляет модель в subscription-backed Codex OAuth channel. У него нет metered per-token invoice, который можно сверить с таблицей usage. Поэтому `$5/M input`, `$0.50/M cached input` и `$30/M output` — не фактический счёт провайдера, а консервативный budgeting proxy, явно закреплённый в `.env`/`.env.example`.

Формула стоимости строки (`prs-ip0.9`):

```
(inputTokens - cachedInputTokens) × inputRate
+ cachedInputTokens × cachedInputRate
+ outputTokens × outputRate
```

Если провайдер не сообщил `cachedInputTokens`, весь input тарифицируется по обычной ставке: неподтверждённый cache hit не приписывается. Пример из `prs-ip0.9`: при `inputTokens=17710`, `cachedInputTokens=1536`, `outputTokens=163` оценка равна `$0.086528` вместо `$0.093440` без учёта кэша.

Soft limit установлен в `$30` на владельца в месяц. При целевом среднем 16k input и примерно 500 output tokens один ход оценивается в `$0.095`; лимит покрывает около 315 ходов, то есть примерно 10 ходов в день. Для 10–15 участников planning envelope составляет `$300–450` в месяц. Soft limit только пишет warning и не блокирует запросы.

Начиная с `prs-ip0.4` один ход владельца пишет несколько строк usage, поэтому audit-событие `usage_soft_limit_exceeded` и operational warning выдаются один раз — на строке, которая фактически перешла порог. Предупреждение в ответе владельцу по-прежнему появляется на каждом ходе, пока месяц выше лимита.

## Единица строки и разрез по источнику

Строка `minutka_private.usage` — это **один LLM-вызов одного хода**, а не ход целиком. Ключ дедупликации — `(request_id, user_id, source)`; `source` принимает значения:

| source | что считает |
|---|---|
| `chat` | основной ход диалога (агрегат по всем шагам хода, `prs-ip0.10`) |
| `guard` | request integrity guard, вызывается на каждом ходе |
| `summarization` | компакция треда, использует `request_id` того же хода |
| `onboarding` | извлечение профиля на каждом ответе онбординга |

`guard` и `summarization` идут с тем же `request_id`, что и `chat`, поэтому без `source` в ключе они молча отбрасывались бы существующим `ON CONFLICT DO NOTHING`. Исторические строки до миграции `0038` бэкфилены значением `chat`: все они пришли из основного раннера.

Колонка `cached_input_tokens` nullable по смыслу: `NULL` — «провайдер не сообщал разбивку», `0` — «провайдер сообщил cache miss». Строкам до миграции `0039` cache hit не приписывается ни в какую сторону; месячный агрегат отдаёт `cachedInputTokens` (сумма по строкам с отчётом) отдельно от `cachedInputUnknownRecords` (число строк без отчёта), чтобы «неизвестно» не читалось как подтверждённый ноль.

## После deployment

1. Обновить deployment `.env`:

```bash
ASSISTANT_USAGE_MONTHLY_SOFT_LIMIT_USD=30
ASSISTANT_USAGE_INPUT_USD_PER_MILLION_TOKENS=5
ASSISTANT_USAGE_CACHED_INPUT_USD_PER_MILLION_TOKENS=0.5
ASSISTANT_USAGE_OUTPUT_USD_PER_MILLION_TOKENS=30
```

2. Применить миграции (`npm run db:migrate`) и перезапустить runtime **до** замера. Схемное окно `0038`+`0039` выкатывается целиком: замер по промежуточной схеме пришлось бы повторять.
3. Выполнить не менее 10 репрезентативных ходов: короткий ответ, чтение документа, один tool call и один multi-step tool loop.
4. Собрать строки `assistant_turn_usage` из сохранённого runtime-журнала, включая `source` и `contextSourceCharacters`. Не прикладывать owner text; достаточно числовых полей, идентификаторов источников и request id. Один ход даёт несколько строк: `guard` и `chat` всегда, `summarization` — когда сработала компакция.
5. Посчитать:
   - среднее и максимум `inputTokens` на ход, считая ход как сумму строк с одним `request_id`;
   - распределение `llmSteps` (1/2/3/4) по строкам `source='chat'`;
   - долю каждого `source` в месячной сумме — что именно оптимизировать: модель, частоту компакции или guard;
   - cache hit rate: считать **только** по строкам с ненулевым отчётом, то есть `cached_input_tokens IS NOT NULL`; строки с `NULL` исключать из знаменателя, а не считать их cache miss;
   - для каждого `sourceId`: `sum(contextSourceCharacters[sourceId]) / sum(всех contextSourceCharacters)` — долю источника в фактически собранном input-контексте; отдельно сложить стабильный префикс (`base_instructions`, `agent_manual`, `profile`) и сравнить его с остальными секциями.
6. Записать post-change выборку рядом с baseline. Если среднее выше 16k, сначала разбирать ходы с `llmSteps > 1`; не увеличивать soft limit вместо устранения повторной пересылки префикса.

SQL для агрегата по durable usage в разрезе источника (без текстов):

```sql
SELECT source,
       count(*) AS rows,
       count(DISTINCT request_id) AS requests,
       sum(input_tokens) AS input_tokens,
       sum(output_tokens) AS output_tokens,
       round(avg(input_tokens)) AS avg_input_tokens,
       max(input_tokens) AS max_input_tokens,
       count(*) FILTER (WHERE cached_input_tokens IS NULL) AS cache_unreported_rows,
       sum(cached_input_tokens) AS cached_input_tokens,
       sum(estimated_cost_usd_micros) / 1000000.0 AS estimated_cost_usd
FROM minutka_private.usage
WHERE occurred_at >= :'deployed_at'::timestamptz
GROUP BY ROLLUP (source);
```

Cache hit rate по строкам с фактическим отчётом:

```sql
SELECT sum(cached_input_tokens)::numeric / nullif(sum(input_tokens), 0) AS cached_share
FROM minutka_private.usage
WHERE occurred_at >= :'deployed_at'::timestamptz AND cached_input_tokens IS NOT NULL;
```

`llmSteps` остаётся operational-only и в durable схему не пишется.

После deployment `prs-ip0.4`+`prs-ip0.9` monthly сумма покрывает все LLM-вызовы контура владельца: chat, guard, компакцию треда и извлечение профиля онбординга. Chat-строка описывает весь ход целиком; `inputTokens`, `outputTokens`, `totalTokens` и `cachedInputTokens` берутся из одной области. Если провайдер сообщает `cachedInputTokens > inputTokens`, producer пишет operational warning и сохраняет строку без cached-поля, поэтому soft limit продолжает учитывать ход.

Первый ответ после онбординга (`createFirstOnboardingResponse`) в проде детерминированный и LLM не вызывает, поэтому отдельной строки usage не даёт.

Исторические строки до deployment `prs-ip0.10` нельзя смешивать с новым срезом: у них `inputTokens` относится к последнему шагу, а `cachedInputTokens` вообще не сохранялся (колонка появилась только в `0039`, старые строки остаются `NULL`). Все строки до миграции `0038` помечены `source='chat'` бэкфиллом. Cache hit rate и разрез по источнику считать только по строкам после deployment; следующим шагом остаётся живой замер `prs-ip0.13`.
