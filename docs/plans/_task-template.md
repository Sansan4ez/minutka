# Шаблон исполняемой задачи br

Тело ниже переносится в `description`, не в отдельный план `.md`. Метаданные (title, type, priority, parent, зависимости) задаются средствами `br`. Правила — [CONVENTIONS.md](../CONVENTIONS.md#контракт-готовности-исполняемой-задачи).

**Лимиты:** Intent ≤1200 символов, весь description ≤6000 символов, включая Markdown, пробелы, переводы строк и код. Условный пересчёт: 1 токен ≈4 символа. Эпик — отдельный контейнер, см. [_plan-template.md](./_plan-template.md).

## Скелет description

Удалить все подсказки и заменить placeholders. Пустых секций не оставлять; отсутствие дополнительных NFR указать явно.

````markdown
## Intent
<Что требуется, зачем, какой наблюдаемый результат; ≤1200 символов.>

## Design
Misfit: <конкретное расхождение с записанным assumption; источник и §/символ>.
Решение: <выбранное поведение, границы слоёв, инварианты>.
Предусловия: <готовые результаты зависимостей, конкретные значения либо «нет»>.
Контракты/контекст: <всё необходимое для реализации, не «прочитай RFC»>.

Изменить: `<path>`, символ/секция `<name>`, исходная ревизия `<commit hash>`.
```ts
// Минимальный точный фрагмент существующего файла.
```
Проверка: `<spec path>`, `<test symbol>`, та же ревизия.
```ts
// Необходимый фрагмент существующего test harness.
```
Новые файлы: <пути и назначение либо «нет»>.

## Non-goals
- <Какие результаты намеренно не обеспечиваем.>

## Non-scope
- <Какие компоненты/изменения не входят в работу.>

## Acceptance Criteria
| ID | Given: состояние / конкретный вход | When: действие | Then: точный выход / состояние / эффекты |
|---|---|---|---|
| SPEC-<AREA>-001 | <значения> | <вызов> | <результат> |
| SPEC-<AREA>-002 | <применимая граница/ошибка> | <вызов> | <результат, отсутствие нежелательных эффектов> |

NFR: <конкретный предел, условия, способ проверки; либо «Дополнительных NFR нет»>.
Проверки: <путь spec, соответствие ID тестам, точная команда; для TS/JS в pi — LSP diagnostics>.
````

## Заполненный пример

**Учебный пример, не описание существующих файлов «Минутки».** Пути и ревизия вымышлены; перед созданием реальной задачи автор подставляет актуальные данные. Пример демонстрирует весь контекст маленького среза, а не предлагает новую продуктовую работу.

````markdown
## Intent
Исправить изоляцию in-memory списка: list(groupId) возвращает только записи указанной группы в порядке вставки. Сейчас возвращаются записи всех групп, поэтому тестовый адаптер нарушает контракт порта.

## Design
Misfit: контракт ItemStore.list ниже требует group-scoped чтение, но InMemoryItemStore.list не фильтрует rows. Предусловий нет.
Решение: фильтровать по точному равенству groupId; не мутировать rows. Порт и формат результата не меняются.

Изменить `src/application/in-memory-item-store.ts`, InMemoryItemStore.list; ревизия `1111111111111111111111111111111111111111`:
```ts
export type Item = { id: string; groupId: string };
export interface ItemStore {
  // Только записи groupId, в порядке вставки.
  list(groupId: string): Promise<Item[]>;
}
export class InMemoryItemStore implements ItemStore {
  constructor(private readonly rows: Item[]) {}
  async list(_groupId: string): Promise<Item[]> {
    return [...this.rows];
  }
}
```
Новый файл `specs/executable/item-store.spec.ts`. Runner — стандартный node:test через tsx; шаблон целиком:
```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryItemStore } from '../../src/application/in-memory-item-store.js';
test('SPEC-ITEM-001: group isolation', async () => {
  const rows = [{ id: 'a1', groupId: 'g1' }, { id: 'a2', groupId: 'g2' }];
  const store = new InMemoryItemStore(rows);
  assert.deepEqual(await store.list('g1'), [rows[0]]);
  assert.deepEqual(rows, [{ id: 'a1', groupId: 'g1' }, { id: 'a2', groupId: 'g2' }]);
});
```
Добавить остальные сценарии тем же test/assert API; tsx уже установлен.

## Non-goals
- Не вводим авторизацию и проверку существования группы.

## Non-scope
- Не меняем PostgreSQL, HTTP, Telegram и порт ItemStore.

## Acceptance Criteria
| ID | Given | When | Then |
|---|---|---|---|
| SPEC-ITEM-001 | rows=[a1/g1,a2/g2] | list('g1') | [{id:'a1',groupId:'g1'}]; rows неизменны |
| SPEC-ITEM-002 | rows=[a1/g1,a2/g2] | list('g3') | []; rows неизменны |
| SPEC-ITEM-003 | rows=[] | list('g1') | [] |
| SPEC-ITEM-004 | rows=[a3/g1,a2/g2,a1/g1] | list('g1') | [a3/g1,a1/g1] в таком порядке |

NFR: все четыре сценария выполняются без сети и LLM; код адаптера не добавляет внешних вызовов. Дополнительных требований к latency нет.
Проверки: четыре test с указанными ID в specs/executable/item-store.spec.ts; `node --import tsx --test specs/executable/item-store.spec.ts`; LSP diagnostics для изменённого адаптера и нового spec.
````

## Чеклист перед claim

- [ ] Intent ≤1200, description ≤6000 символов (Unicode code points).
- [ ] Misfit и принятые решения конкретны; открытых вопросов для реализации нет.
- [ ] Необходимый контекст, актуальные фрагменты файлов и test harness включены.
- [ ] Non-goals и Non-scope заполнены.
- [ ] Functional/NFR максимально выражены конкретными проверяемыми сценариями.
- [ ] У сценариев есть ID, путь проверки и команда; применимые ошибки и границы включены.
- [ ] `br lint <id>` зелёный; содержательные проверки сделаны отдельно.
