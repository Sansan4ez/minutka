# Калибровка usage и стоимости пилота

> **Унаследовано от персонального ассистента.** Команды и стек служат операционным фундаментом клона; хосты, unit names и пути должны быть перенастроены под «Минутку». Живые продуктовые и privacy-решения: [RFC «Минутки»](../architecture/rfc-minutka-tenancy-and-reporting.md).


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

**Исторический baseline снят по колонке с токенами последнего LLM-шага и как per-turn baseline недействителен.** Начиная с `prs-ip0.10`, runtime выбирает один согласованный источник за весь ход: `result.totalUsage`, затем сумму `steps[].usage`, затем одношаговый `result.usage`. Таблица выше остаётся только исторической нижней границей неизвестного размера и замещена post-deployment срезом ниже.

## Post-deployment срез 03.08.2026

Срез `prs-ip0.13` снят после deployment финальной usage-схемы `0038`+`0039` и рестарта runtime. Окно основной выборки началось `2026-08-02T23:08:17Z`. В неё вошли 10 успешных owner-ходов через employee CLI и один scheduled `evening_reflection` через живой Telegram. Технические ходы переноса и возврата расписания, а также один дополнительный запрос, завершившийся HTTP 500 до chat usage, в baseline не входят.

Состав выборки без owner text:

| тип | request id | `llmSteps` |
|---|---|---:|
| короткий ответ | `req_decf5566-aeba-43b0-ae68-7e2d947edf94` | 2 |
| короткий ответ | `req_8ca39b63-682a-4398-8b95-a94abd9ed503` | 1 |
| короткий ответ | `req_f78f5b70-584d-404c-88f1-b90c488500f8` | 2 |
| список документов, один tool loop | `req_d579163d-f879-494c-a72e-8d61bacee0ce` | 2 |
| чтение документа, один tool loop | `req_4637d9d4-8490-4774-99af-107d24ea5997` | 2 |
| чтение расписаний, один tool loop | `req_882a0888-fb1e-4528-9472-7ba08a5998ec` | 2 |
| чтение задач, один tool loop | `req_dddd69fa-3c11-4300-9e88-582bcc26fe8f` | 2 |
| список + чтение документа, multi-step loop | `req_420c1820-330f-4100-a8e6-65a0c2d89af6` | 3 |
| расписания + задачи, multi-tool loop | `req_1a01ec3f-d741-472f-bfb3-5fd302b82f8c` | 2 |
| чтение двух документов, multi-step loop | `req_d4f419cf-eb99-4547-a508-9e74506fa822` | 4 |
| scheduled `evening_reflection` | `req_041ff4e7-a480-4a33-b698-669a9722cee9` | 2 |

Метрики считаются на ход как сумма durable-строк с одним `request_id` (`chat` + `guard` + сработавшая `summarization`):

| метрика | значение |
|---|---:|
| ходы | 11 |
| входные токены | 417 790 |
| выходные токены | 4 624 |
| средние входные токены на ход | 37 981 |
| максимум входных токенов | 82 436 |
| ходы с `cachedInputTokens > 0` | 11 из 11 (100%) |
| `sum(cachedInputTokens) / sum(inputTokens)` | 86.27% |
| строки с неизвестным cache report (`NULL`) | 0 |
| оценка стоимости с `$5/M input`, `$0.50/M cached input`, `$30/M output` | $0.605654 |

Распределение и разбор по шагам подтверждают, что превышение цели 16 000 связано прежде всего с повторной пересылкой контекста в tool loops:

| `llmSteps` | ходы | средний input на ход | максимум |
|---:|---:|---:|---:|
| 1 | 1 | 15 529 | 15 529 |
| 2 | 8 | 32 948 | 36 884 |
| 3 | 1 | 56 244 | 56 244 |
| 4 | 1 | 82 436 | 82 436 |

Доля input по источнику LLM-вызова:

| source | строки | input tokens | доля input |
|---|---:|---:|---:|
| `chat` | 11 | 406 931 | 97.40% |
| `guard` | 11 | 8 955 | 2.14% |
| `summarization` | 1 | 1 904 | 0.46% |

Разбивка фактически собранного chat-контекста по Unicode characters (`543 634` characters суммарно по 11 ходам) служит прокси относительного веса секций, а не точной tokenizer-атрибуцией:

| source id | characters | доля |
|---|---:|---:|
| `context` | 243 419 | 44.78% |
| `agent_manual` | 217 019 | 39.92% |
| `history` | 36 368 | 6.69% |
| `context_index` | 21 153 | 3.89% |
| `records` | 18 601 | 3.42% |
| `thread_summary` | 4 000 | 0.74% |
| `profile` | 2 453 | 0.45% |
| `base_instructions` | 621 | 0.11% |

Стабильный префикс (`base_instructions` + `agent_manual` + `profile`) занимает 40.49% собранных characters, некэшируемая часть — 59.51%. `context` + `context_index` вместе занимают 48.67%, поэтому решение push vs pull должно начинаться с этих секций, а не с дальнейшего роста manual ceiling.

Scheduled `evening_reflection` успешно доставлен, fire завершён со `status='succeeded'`, после чего расписание возвращено на `21:00 Asia/Yekaterinburg`. Его chat-строка получила 18 432 cached из 34 157 input tokens (53.96%), тогда как обычные двухшаговые chat-ходы вместе получили 92.66%. Значимо более низкая доля подтверждает, что ход с `requiredProcessId` не попал в общую cache line обычного chat. Одного scheduled хода недостаточно, чтобы доказать повторное использование отдельной ежедневной линии, но перенос trusted-блока после общего manual теперь имеет измеримое основание.

Цель `<= 16 000` в среднем не достигнута. Soft limit не повышается: следующий разбор начинается с 2–4-шаговых ходов и повторной пересылки `context`/`context_index` на каждом шаге.

### Повтор после очистки canonical KB (`prs-ubeb`)

Первый post-deployment срез выше использовал старый MinIO owner scope: 169 документов, 818 721 UTF-8 bytes, включая `.vtt` и `.txt`. После подтверждения резервной копии prefix `pilot-admin/` очищен вместе со всеми 170 object versions, затем импортирован Git snapshot `ebfcfa6` из `/home/admin/user_knowledge_base`: 13 Markdown-документов, 66 571 bytes. Повторный import вернул `13 skipped`; чужие owner prefixes не затрагивались.

Очищенное дерево дало полный file index без `folder_rollup`: `context_index` уменьшился с 1 923 до 841 characters на ход. Однако при прежнем `ASSISTANT_CONTEXT_DOCUMENTS=12` projection продолжал заполнять `context` почти до ceiling: 23 752 characters вместо 22 129 в старом срезе. После пяти priority-документов аллокатор добавлял non-core Markdown до лимита. Поэтому очистка дерева без калибровки push policy снизила input только на 1.81% по 10 ходам с одинаковым `llmSteps`.

Измеренный priority-набор состоит из пяти полных документов: Persona, Goals and priorities, Projects, Soul и Tags/Classifications. Вместе с section wrapper и degradation marker он занимает 19 602 characters. Для pilot deployment установлен:

```dotenv
ASSISTANT_CONTEXT_DOCUMENTS=5
```

Остальные восемь документов остаются discoverable через полный file index и owner-bound `searchDocuments`/`readDocument`; `context` ceiling 24 000 и `context_index` ceiling 6 000 не менялись. Projection с этим лимитом содержит ровно пять full priority documents и один осознанный `document_limit` audit для восьми pull-only документов. `document_too_large`, `folder_rollup` и non-Markdown в canonical KB отсутствуют.

Финальный срез с `documents=5` снова содержит 10 успешных CLI-ходов и один scheduled `evening_reflection`:

| метрика | старая KB, `documents=12` | очищенная KB, `documents=5` |
|---|---:|---:|
| ходы | 11 | 11 |
| входные токены | 417 790 | 390 733 |
| выходные токены | 4 624 | 4 131 |
| средний input на ход | 37 981 | 35 521 |
| максимум input | 82 436 | 77 486 |
| cached share | 86.27% | 82.81% |
| оценочная стоимость выборки | $0.605654 | $0.621467 |
| `context` characters на обычный ход | 22 129 | 19 602 |
| `context_index` characters на ход | 1 923 | 841 |

Стоимость полной небольшой выборки не является A/B-оценкой сама по себе: число model-selected шагов изменилось. На 10 сценариях с одинаковым `llmSteps` средний input снизился с 38 468 до 34 685, то есть на **9.83%**. В прямом сравнении очищенной KB до и после ограничения push девять сценариев сохранили одинаковый `llmSteps`; их средний input снизился с 35 892 до 33 350 (**−7.08%**). Одношаговый ход после калибровки получил 14 328 input tokens и укладывается в цель 16 000; 2–4-шаговые loops по-прежнему пересылают системный контекст повторно.

Финальное распределение `llmSteps`: `1 → 1 ход`, `2 → 7`, `3 → 2`, `4 → 1`. Scheduled chat получил 16 384 cached из 31 917 input tokens (51.33%), поэтому вывод о его отдельной cache line сохраняется.

Проверка двойной отправки подтвердила проблему для core-документов: явный `readDocument` для Goals/Persona отправляет документ второй раз как tool result, хотя полное содержимое уже находится в push-проекции. Для non-core `04_Продукты_и_услуги.md` дублирования нет: документ отсутствует в push и читается только pull-инструментом. Выбран гибридный режим: пять небольших core-документов остаются push для одношаговой персонализации; полный отказ от push не принят, потому что каждый pull добавляет LLM-шаг и по живому срезу это дороже сохранённых 19.6k characters. Следующая дешёвая оптимизация — не вызывать `readDocument` для уже полностью включённого core path.

Срез 31.07–02.08 показывал две группы ходов: обычные ответы около 15–18k input и tool-loop ходы до 71–77k. Поэтому после deployment основной operational signal — `assistant_turn_usage`: одна metadata-only строка на каждый LLM-вызов с `source`, `inputTokens`, `outputTokens`, `llmSteps`, `requestId` и, если провайдер сообщил, `cachedInputTokens`. У строки `source='chat'` дополнительно есть фактические Unicode-размеры включённых секций в `contextSourceCharacters`.

До deployment был зафиксирован воспроизводимый provider/Mastra probe: 10 316 input tokens на одношаговый вызов, из них 9 984 cached на повторе. Живой post-change срез выше показывает, что одношаговый ход укладывается в цель `<= 16 000`, но среднее по репрезентативной выборке превышает её из-за 2–4-шаговых tool loops. Это не hard cap: soft limit не блокирует запросы, а оператор разбирает повторную пересылку контекста по шагам.

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

## Ежемесячный агрегат группы

Основной путь ежемесячной проверки planning envelope — обязательный tenant-scoped admin CLI:

```bash
npm run cli -- admin usage --company <company_id> --group <group_id> --month YYYY-MM
```

Команда возвращает суммарные input/output/cached/total tokens и оценочную стоимость, тот же разрез по `source`, cache share, число и идентификаторы участников выше индивидуального soft limit. Cache share считает знаменатель только по строкам, где `cached_input_tokens IS NOT NULL`; строки без provider breakdown не считаются cache miss. Вывод metadata-only: тексты запросов и ответов не читаются и не печатаются.

SQL ниже остаётся fallback для детальной калибровки после изменения prompt/context и для operational-only полей, которых нет в durable агрегате.

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

Исторические строки до deployment `prs-ip0.10` нельзя смешивать с новым срезом: у них `inputTokens` относится к последнему шагу, а `cachedInputTokens` вообще не сохранялся (колонка появилась только в `0039`, старые строки остаются `NULL`). Все строки до миграции `0038` помечены `source='chat'` бэкфиллом. Cache hit rate и разрез по источнику считаются только по строкам после deployment; первый такой живой замер зафиксирован выше в `prs-ip0.13`.
