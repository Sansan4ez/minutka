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

Срез 31.07–02.08 показывает две группы ходов: обычные ответы около 15–18k input и tool-loop ходы до 71–77k. Поэтому после deployment основной operational signal — `assistant_turn_usage`: одна metadata-only строка на chat turn с `inputTokens`, `outputTokens`, `llmSteps` и, если провайдер сообщил, `cachedInputTokens`.

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

Локальный CLIProxyAPI направляет модель в subscription-backed Codex OAuth channel. У него нет metered per-token invoice, который можно сверить с таблицей usage. Поэтому `$5/M input` и `$30/M output` — не фактический счёт провайдера, а консервативный budgeting proxy, явно закреплённый в `.env`/`.env.example`.

Soft limit установлен в `$30` на владельца в месяц. При целевом среднем 16k input и примерно 500 output tokens один ход оценивается в `$0.095`; лимит покрывает около 315 ходов, то есть примерно 10 ходов в день. Для 10–15 участников planning envelope составляет `$300–450` в месяц. Soft limit только пишет warning и не блокирует запросы.

## После deployment

1. Обновить deployment `.env`:

```bash
ASSISTANT_USAGE_MONTHLY_SOFT_LIMIT_USD=30
ASSISTANT_USAGE_INPUT_USD_PER_MILLION_TOKENS=5
ASSISTANT_USAGE_OUTPUT_USD_PER_MILLION_TOKENS=30
```

2. Перезапустить runtime и выполнить не менее 10 репрезентативных ходов: короткий ответ, чтение документа, один tool call и один multi-step tool loop.
3. Собрать строки `assistant_turn_usage` из сохранённого runtime-журнала. Не прикладывать owner text; достаточно числовых полей и request id.
4. Посчитать:
   - среднее и максимум `inputTokens` на ход;
   - распределение `llmSteps` (1/2/3/4);
   - cache hit rate: доля ходов с `cachedInputTokens > 0` и отношение `sum(cachedInputTokens) / sum(inputTokens)`.
5. Записать post-change выборку рядом с baseline. Если среднее выше 16k, сначала разбирать ходы с `llmSteps > 1`; не увеличивать soft limit вместо устранения повторной пересылки префикса.

SQL для агрегата по durable chat usage (без текстов):

```sql
SELECT count(*) AS turns,
       sum(input_tokens) AS input_tokens,
       sum(output_tokens) AS output_tokens,
       round(avg(input_tokens)) AS avg_input_tokens,
       max(input_tokens) AS max_input_tokens,
       sum(estimated_cost_usd_micros) / 1000000.0 AS estimated_cost_usd
FROM minutka_private.usage
WHERE occurred_at >= :'deployed_at'::timestamptz;
```

`llmSteps` и `cachedInputTokens` пока operational-only: они сознательно не меняют usage schema до выполнения отдельной задачи `prs-ip0.4`, которая добавит source attribution и учёт всех вспомогательных LLM-вызовов.

Текущая monthly сумма после deployment `prs-ip0.10` остаётся нижней оценкой полного расхода owner contour по одной известной причине: вспомогательные LLM-вызовы идут мимо счётчика (`prs-ip0.4`). Chat-строка теперь описывает весь ход целиком; `inputTokens`, `outputTokens`, `totalTokens` и `cachedInputTokens` берутся из одной области. Если провайдер сообщает `cachedInputTokens > inputTokens`, producer пишет operational warning и сохраняет строку без cached-поля, поэтому soft limit продолжает учитывать ход.

Исторические строки до deployment `prs-ip0.10` нельзя смешивать с новым срезом: у них `inputTokens` относится к последнему шагу, а `cachedInputTokens` мог быть суммой по шагам. Cache hit rate считать только по строкам после deployment; следующим шагом остаётся повторный живой замер.
