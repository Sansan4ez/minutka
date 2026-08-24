import type { ActivitySystem } from "../../domain/insights.js";

type MappedActivitySystem = Exclude<ActivitySystem, "other">;

type ActivitySystemModelMappingEntry = {
  value: MappedActivitySystem;
  examples: readonly string[];
};

/**
 * Compact provider-visible guide for mapping product/channel names to the
 * global generic activity-system dictionary. The operator runbook carries the
 * fuller inventory wording; executable parity specs keep both views aligned.
 */
export const activitySystemModelMapping = [
  { value: "bitrix24", examples: ["Bitrix24"] },
  { value: "crm", examples: ["amoCRM", "самописная CRM"] },
  { value: "one_c", examples: ["1С:УТ", "1С:Бухгалтерия", "1С:УНФ", "ERP"] },
  { value: "spreadsheets", examples: ["Excel", "Google Sheets"] },
  { value: "email", examples: ["корпоративная и внешняя почта"] },
  { value: "messengers", examples: ["Telegram", "WhatsApp", "видеосервис"] },
  { value: "task_tracker", examples: ["задачи Bitrix24", "Trello", "Jira", "Планфикс"] },
  { value: "telephony", examples: ["облачная АТС", "панель оператора", "обзвон"] },
  { value: "tender_platform", examples: ["ЕИС/zakupki", "B2B-Center", "Росэлторг"] },
  { value: "logistics_system", examples: ["TMS/WMS", "кабинеты перевозчиков", "логистические порталы"] },
  { value: "learning_platform", examples: ["LMS/СДО", "кабинет курса"] },
  { value: "paper_or_verbal", examples: ["бумажный документ", "устная договорённость"] },
] as const satisfies readonly ActivitySystemModelMappingEntry[];

export const activitySystemModelMappingGuide = [
  "Generic system mapping (store only the enum value, never the brand or internal name):",
  activitySystemModelMapping
    .map(({ value, examples }) => `${examples.join(", ")} -> ${value}`)
    .join("; "),
  "An unfamiliar brand maps to an existing generic value only when its type is unambiguous from context; a brand name alone with no clear type is omitted rather than guessed. Use other only for a known system type that this generic dictionary does not cover.",
].join(" ");
