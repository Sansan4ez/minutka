1. Нужно выбрать один из двух вариантов:

 1. Подключить /docs фактически:
     - добавить документы в registry;
     - определить механизм выбора документов;
     - передавать выбранные документы в context;
     - добавить validation и tests.

 2. Не считать /docs runtime-инструкциями:
     - убрать /docs из runtime priority;
     - оставить документы только как developer/product documentation;
     - перенести обязательные runtime-правила в AGENTS.md или process-файлы.

 Для текущего MVP предпочтительнее первый вариант в ограниченном виде: добавить явные runtimeDocs для product-boundary, methodology и privacy-boundary, но не
 загружать все документы подряд.

2. Для текущего проекта возможны два простых решения:

 #### Вариант A — registry как runtime source of truth

 - loader строит allow-list из registry.json;
 - router schema валидирует только структуру, а не конкретный статический enum;
 - process ids становятся runtime-значениями;
 - domain types используют более общий branded/string type с проверкой loader.

 #### Вариант B — код как source of truth

 - создать единый process-catalog.ts;
 - registry.json, schemas и prompt routing сверять с ним;
 - добавить executable test на полное совпадение registry и catalog.

 Для Agent Vault логичнее вариант A, поскольку смысл registry — описывать доступные процессы без изменения application-кода при каждом добавлении markdown-файла.


