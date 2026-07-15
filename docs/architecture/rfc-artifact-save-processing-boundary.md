# RFC: контракт входящего артефакта и граница save/process

## Status

**Accepted для пилота-прототипа (2026-07-15).** Документ фиксирует typed-контракт файла, owner-scoped дедупликацию и разделение durable save от необязательной асинхронной обработки.

Related:
- [RFC архитектуры персонального ассистента](./rfc-personal-assistant-architecture.md) (§5–7)
- [RFC агент-ведомого роутинга](./rfc-agent-led-routing.md) (§2–3)
- br-эпик `pers-assist-sb1` и задача `pers-assist-sb1.1`

---

## 1. Проблема

Текущий `BlobStore` сохраняет бинарный объект по заданному вызывающим кодом ключу. `IdeaSource { kind: "blob", blobKey }` связывает идею с этим ключом, но не описывает самостоятельный пользовательский артефакт: отсутствуют полный digest, transport provenance, отдельный logical id, статус ссылки и идемпотентность повторной доставки.

Если добавить обработку файла прямо в upload-path, доступность сохранения начнёт зависеть от LLM, распознавания и внешних processors. Если использовать digest как глобальный публичный ключ, поведение системы сможет косвенно показать одному владельцу наличие тех же байтов у другого владельца.

Нужна минимальная граница, на которой система сначала надёжно принимает файл, а затем при необходимости запускает независимую постобработку.

## 2. Решение

### 2.1. Две независимые стадии

```text
transport payload
      │
      ▼
ArtifactStore.save                 обязательная синхронная стадия
  ├─ валидирует owner и metadata
  ├─ считает полный SHA-256
  ├─ сохраняет immutable content в owner-scoped CAS
  ├─ создаёт logical reference / возвращает duplicate delivery
  └─ возвращает успешный durable result
      │
      └──── optional ArtifactProcessingQueue.enqueue
                 ├─ OCR / STT / parsing / classification
                 └─ retryable, не откатывает save
```

`ArtifactStore.save` не вызывает LLM, OCR, STT, классификатор или processor. Успех durable save не зависит от их доступности. Постановка processing job выполняется только после успешного save; ошибка enqueue возвращается как отдельная операционная ошибка и не удаляет сохранённый артефакт.

### 2.2. Typed-контракт logical artifact/reference

Канонический порт определён в [`src/application/artifact-store.ts`](../../src/application/artifact-store.ts).

Обязательные поля:

| Поле | Правило |
|---|---|
| `ownerId` | trusted owner scope; валидируется тем же fail-closed `assertUserId`, что существующие stores |
| `artifactId` | opaque logical id; не выводится из имени файла или transport id |
| `contentDigest` | полный lowercase SHA-256, 64 hex-символа |
| `originalFileName` | пользовательское имя; не участвует в physical key |
| `size` | размер сохранённых байтов |
| `source` | typed provenance без URL и credentials |
| `status` | `active` или `deleted` |
| `createdAt` | время durable save |

`declaredMediaType` отражает transport/client metadata и не считается доверенным. `detectedMediaType` добавляется, когда безопасное определение типа доступно. Несовпадение не меняет digest и не препятствует сохранению; processor может использовать его как сигнал валидации.

`caption` — пользовательские данные. Он хранится только в logical reference, не в audit metadata и не в имени объекта.

Бинарное `body` существует только во входе `SaveArtifactInput`. Оно не является полем `ArtifactReference`, не записывается в PostgreSQL/audit и не включается в LLM context. Агент получает только bounded metadata или производный текст через отдельную проекцию/use-case.

### 2.3. Owner-scoped CAS

Immutable content object адресуется парой:

```text
(ownerId, contentDigest)
```

Рекомендуемый object key адаптера:

```text
{ownerId}/cas/sha256/{digest[0..1]}/{fullDigest}
```

Полный digest обязателен; усечённый digest нельзя использовать как identity. Одинаковые байты одного владельца переиспользуют один content object. Между владельцами не существует observable dedup: API не сообщает, есть ли такой digest в другом owner scope, а physical key всегда содержит owner scope.

Пользовательские имена, caption и transport metadata не входят в CAS object. Они живут в отдельной logical reference, поэтому повторная отправка тех же байтов под другим именем не меняет immutable content.

### 2.4. Два вида дедупликации

Дедупликация доставки и дедупликация содержимого — разные механизмы.

1. **Delivery dedup** использует `(ownerId, source.deliveryKey)`. Повтор того же Telegram update/API request возвращает исходную logical reference с `deliveryDisposition: "duplicate_delivery"` и не создаёт вторую запись.
2. **Content dedup** использует `(ownerId, contentDigest)`. Новая доставка тех же байтов может создать новую logical reference, но возвращает `contentDisposition: "reused"` и не дублирует content object.

Это сохраняет идемпотентность retry и одновременно не теряет пользовательский факт повторной отправки.

Для Telegram рекомендуемый delivery key строит transport adapter из стабильной provenance, например `telegram:{chatId}:{messageId}:{payloadKind}:{fileUniqueId-or-fileId}`. Для media group каждый payload остаётся отдельной доставкой; `mediaGroupId` связывает элементы, но не заменяет `messageId`.

### 2.5. Telegram provenance и forwarded semantics

`source.kind === "telegram"` хранит только:

- `chatId`, `messageId`;
- `payloadKind` (`document`, `photo`, `video`, `audio`, `animation`, `sticker`, `voice`, `video_note`);
- `fileId` / `fileUniqueId`, если транспорт их дал;
- `mediaGroupId`, если он есть;
- явный boolean `forwarded`;
- opaque `deliveryKey`.

Секретные download URL, bot token, signed URL и request headers запрещены. Typed runtime validation отклоняет неизвестные поля в provenance.

`forwarded` определяется только структурными полями Telegram message (`forward_origin` или эквивалентом версии Bot API). Текст, caption, имя файла, префикс `Fwd:` и наличие URL не являются признаками forwarding. Голосовая заметка остаётся `payloadKind: "voice"`, обычный audio-файл — `"audio"`; это решение принимает transport adapter по типу payload, а не по расширению или media type.

### 2.6. Статусы и удаление

Logical reference имеет два состояния:

```text
active ── delete(ownerId, artifactId) ──> deleted
```

`delete` — owner-scoped, идемпотентное логическое удаление. `deletedAt` фиксируется при первом переходе. Удалённая reference не показывается в обычных list/projection и не принимается для новой processing job.

Content object immutable. Физическое удаление выполняет отдельный garbage collector только когда у `(ownerId, contentDigest)` нет active references и завершён согласованный retention/grace period. Удаление одной ссылки не влияет на ссылки другого владельца и не раскрывает их существование.

Processing job имеет независимые состояния `queued | running | succeeded | failed | cancelled`. Ошибка processing не переводит artifact reference из `active` в ошибочное состояние: файл остаётся сохранённым и доступным для retry.

Точная длительность retention, legal hold и экспорт остаются отдельным продуктовым решением. До него реализация не удаляет CAS content синхронно с logical reference.

### 2.7. Миграция с `IdeaSource { kind: "blob", blobKey }`

Миграция выполняется без big bang:

1. Ввести `ArtifactStore` и artifact index, не меняя существующие чтения `IdeaSource`.
2. Для каждого owner-scoped legacy `blobKey` прочитать байты через trusted application adapter, вычислить полный SHA-256 и сохранить/import в owner-scoped CAS.
3. Создать logical reference со стабильным новым `artifactId` и source:

```ts
{
  kind: "legacy_blob",
  deliveryKey: `legacy-idea:${ideaId}:${blobKey}`,
  blobKey,
}
```

4. Расширить `IdeaSource` новым вариантом `{ kind: "artifact"; artifactId: string }`; новые записи используют только его.
5. Backfill обновляет legacy `blob` source на `artifact` после проверки digest, size и owner scope. Операция повторяемая благодаря `deliveryKey`.
6. После периода совместимости удалить запись новых `blob` sources, затем отдельной миграцией удалить legacy variant.

Если legacy blob отсутствует или повреждён, исходная идея не удаляется. Миграция записывает безопасный технический статус для ручного разбора без байтов, caption, URL или чужих owner identifiers в audit.

## 3. Инварианты границы

| Инвариант | Где обеспечивается |
|---|---|
| Persist и process не смешиваются | отдельные `ArtifactStore` и `ArtifactProcessingQueue` |
| Owner validation fail-closed | port validators и каждый adapter/use-case |
| Бинарные данные не попадают в PostgreSQL/audit/LLM context | `body` отсутствует в persisted result; projections metadata-only |
| Cross-owner dedup не наблюдаем | physical/content identity включает `ownerId`; API owner-scoped |
| Retry Telegram update идемпотентен | unique `(ownerId, deliveryKey)` |
| Повтор тех же байтов может быть отдельной ссылкой | content digest не заменяет delivery key |
| Forwarded определяется payload | transport adapter, не эвристика текста/имени |
| Save доступен без processors/LLM | processing начинается только после durable result |

## 4. Trade-offs

- Отдельный artifact index добавляет PostgreSQL-таблицы, но убирает transport metadata из object keys и даёт owner-scoped list/status/delete.
- Owner-scoped CAS может физически хранить одинаковые байты нескольких владельцев. Это сознательная цена простой privacy-модели без cross-owner side channels.
- SHA-256 считается до подтверждения save и требует линейного прохода по данным. На пилоте допустим bounded upload; production adapter должен считать digest потоково, не буферизуя крупный файл второй раз.
- Логическое удаление не освобождает место мгновенно. Это сохраняет надёжность ссылок и позволяет безопасно добавить retention policy позже.

## 5. Error handling & деградация

- Ошибка записи content object или logical reference означает неуспешный save; transport retry использует тот же `deliveryKey`.
- Адаптер обязан сделать save атомарным на уровне наблюдаемого результата: reference не становится `active`, пока content object не подтверждён. Сиротский immutable object допустим и убирается GC; ссылка на отсутствующий content object недопустима.
- Ошибка enqueue/processor не откатывает durable save. Пользователь получает подтверждение сохранения и при необходимости отдельное сообщение «обработка отложена».
- Collision считается нарушением целостности: если существующий `(ownerId, digest)` имеет другой size/байты, адаптер прекращает операцию и поднимает техническую ошибку; он не перезаписывает object.
- Невалидная provenance, owner scope, filename или media type отклоняется до записи.

## 6. Не-цели и когда пересмотреть

Сейчас не вводятся:

- глобальная cross-owner дедупликация;
- content-defined chunking и multipart CAS;
- синхронный OCR/STT/LLM в save-path;
- юридическая длительность retention и legal hold;
- произвольные transport metadata bags.

Chunking пересматривается, когда реальные загрузки превышают практический single-object/streaming предел. Cross-owner storage optimization пересматривается только вместе с отдельной privacy threat model, исключающей observable dedup.

## 7. Acceptance criteria

- [`src/application/artifact-store.ts`](../../src/application/artifact-store.ts) содержит отдельные ports `ArtifactStore` и `ArtifactProcessingQueue`; `save` не принимает processor/LLM dependency.
- `ArtifactReference` содержит owner, logical id, полный SHA-256, имя, declared/detected media type, size, typed source, caption, status и timestamps; бинарный body есть только в `SaveArtifactInput`.
- RFC определяет delivery dedup отдельно от owner-scoped content CAS dedup.
- RFC определяет статусы reference/processing, логическое удаление и отложенный GC.
- RFC описывает поэтапную миграцию `IdeaSource.blobKey` без потери идеи при недоступном legacy blob.
- Telegram forwarding и различие voice/audio определяются структурным payload type, а не эвристикой по тексту, имени или media type.
