// Сквозной классификатор записей ассистента: две оси из RFC §6.1
// (docs/architecture/rfc-personal-assistant-architecture.md). Переиспользуется
// в банке идей (Фаза B), задачах (Фаза C) и инсайтах (Фаза G).

// Ось 1: проект. Расширяемый список кодов; конкретные коды владельца живут в его
// context/06_классификатор.md, здесь — только тип и сентинел. Жёсткий enum не
// используется намеренно: проекты у каждого владельца свои и меняются, иначе
// каждый новый проект требовал бы миграции кода.
export type ProjectCode = string; // "АССИСТЕНТ" | "БНВ" | ... | "БЕЗ_ПРОЕКТА"

// Единственный код-инвариант оси проектов: «проект не определён — агент обязан
// спросить» (RFC §6.1). Неизвестный проект схлопывается сюда, а не отвергается.
export const NO_PROJECT: ProjectCode = "БЕЗ_ПРОЕКТА";

// Ось 2: тип действия по сути (06_классификатор.md).
export type RecordType =
  | "money" // 💰 ДЕНЬГИ (привилегированный тип)
  | "development" // 🔨 РАЗРАБОТКА
  | "content" // 📣 КОНТЕНТ
  | "people" // 🤝 ЛЮДИ
  | "operations" // ⚙️ ОПЕРАЦИИ
  | "knowledge" // 🧠 ЗНАНИЯ
  | "personal"; // ❤️ ЛИЧНОЕ

export const recordTypes: readonly RecordType[] = [
  "money",
  "development",
  "content",
  "people",
  "operations",
  "knowledge",
  "personal",
];

export type Classified = {
  project: ProjectCode; // обязателен; NO_PROJECT ⇒ агент обязан спросить
  type: RecordType; // обязателен
};
