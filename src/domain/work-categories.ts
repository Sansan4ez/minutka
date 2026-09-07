import { z } from "zod";

export const workCategories = [
  "client_sales",
  "tender_procurement",
  "logistics_operations",
  "documents_contracts",
  "finance_accounting",
  "calculations_analysis",
  "internal_management",
  "learning_development",
  "other",
] as const;

export type WorkCategory = (typeof workCategories)[number];

export const workCategorySchema = z.enum(workCategories);

export const workCategoryLabels: Readonly<Record<WorkCategory, string>> = {
  client_sales: "Работа с клиентами и продажи",
  tender_procurement: "Тендеры и закупки",
  logistics_operations: "Логистика и исполнение",
  documents_contracts: "Документы и договоры",
  finance_accounting: "Финансы и учёт",
  calculations_analysis: "Расчёты и аналитика",
  internal_management: "Внутренняя организация работы",
  learning_development: "Обучение и развитие",
  other: "Другое / не удалось классифицировать",
};
