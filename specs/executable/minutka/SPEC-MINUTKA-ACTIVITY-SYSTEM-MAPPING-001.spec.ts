import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { activityCollectionItemSchema } from "../../../src/contracts/minutka-activity.js";
import { activitySystems } from "../../../src/domain/insights.js";
import { collectActivitiesToolDescription } from "../../../src/mastra/tools/activity-collection-tool.js";
import {
  activitySystemModelMapping,
  activitySystemModelMappingGuide,
} from "../../../src/mastra/tools/activity-system-mapping.js";

type RepresentativeAccount = {
  account: string;
  system?: (typeof activitySystems)[number];
};

const representativeAccounts: RepresentativeAccount[] = [
  { account: "Сверял данные в Excel.", system: "spreadsheets" },
  { account: "Отвечал по корпоративной почте.", system: "email" },
  { account: "Провёл созвон в Telegram.", system: "messengers" },
  { account: "Обновлял задачу в Jira.", system: "task_tracker" },
  { account: "Работал в панели облачной АТС.", system: "telephony" },
  { account: "Подал заявку через B2B-Center.", system: "tender_platform" },
  { account: "Проверял рейс в TMS.", system: "logistics_system" },
  { account: "Провёл занятие в LMS.", system: "learning_platform" },
  { account: "Обновил сделку в Bitrix24 CRM.", system: "bitrix24" },
  { account: "Обновил сделку в amoCRM.", system: "crm" },
  { account: "Сверил остатки в 1С:УТ.", system: "one_c" },
  { account: "Согласовал по бумажному документу.", system: "paper_or_verbal" },
  { account: "Работал в системе «Орбита»; её тип не назван." },
  { account: "Работал в явно описанной системе типа, которого нет в словаре.", system: "other" },
];

function runbookSystemValues(runbook: string): string[] {
  const section = runbook
    .split("## Generic mapping типов систем")[1]
    ?.split("**Правила расширения.**")[0];
  if (!section) throw new Error("generic system mapping section is missing");
  return [...section.matchAll(/\| `([^`]+)` \|/gu)].map(([, value]) => value ?? "");
}

describe("SPEC-MINUTKA-ACTIVITY-SYSTEM-MAPPING-001: model-visible generic systems", () => {
  it.each(representativeAccounts)("maps the representative account without storing its brand: $account", ({ system }) => {
    const parsed = activityCollectionItemSchema.parse(system ? { taskCategory: "admin", system } : { taskCategory: "admin" });

    if (system) expect(parsed).toMatchObject({ system });
    else expect(parsed).not.toHaveProperty("system");
    expect(Object.keys(parsed).sort()).toEqual(system ? ["system", "taskCategory"] : ["taskCategory"]);
  });

  it("keeps the compact model mapping in parity with the runbook and closed enum", () => {
    const runbook = readFileSync("docs/runbooks/tenant-reference-directories.md", "utf8");
    const modelValues = activitySystemModelMapping.map(({ value }) => value);
    const expectedGenericValues = activitySystems.filter((value) => value !== "other");

    expect(modelValues).toHaveLength(new Set(modelValues).size);
    expect([...modelValues].sort()).toEqual([...expectedGenericValues].sort());
    expect([...new Set(runbookSystemValues(runbook))].sort()).toEqual([...activitySystems].sort());
    for (const { value, examples } of activitySystemModelMapping) {
      expect(activitySystemModelMappingGuide).toContain(value);
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) expect(runbook.toLocaleLowerCase("ru-RU")).toContain(example.toLocaleLowerCase("ru-RU"));
    }
  });

  it("makes the mapping and non-guessing boundary visible to the active process and tool", () => {
    const eveningProcess = readFileSync("vault/assistant/processes/evening_reflection.md", "utf8");
    const retiredMorningReference = readFileSync("vault/assistant/processes/morning_activity_collection.md", "utf8");

    expect(collectActivitiesToolDescription).toContain(activitySystemModelMappingGuide);
    for (const instructions of [eveningProcess, retiredMorningReference]) {
      expect(instructions).toContain("compact generic mapping");
      expect(instructions).toMatch(/never a brand or internal name/i);
      expect(instructions).toMatch(/otherwise omit rather than guess/i);
    }
    expect(activitySystemModelMappingGuide).toMatch(/Use other only for a known system type.*does not cover/i);
    expect(activitySystemModelMappingGuide).toMatch(/brand name alone.*omitted rather than guessed/i);
  });

  it("does not introduce company-specific system values", () => {
    expect(activitySystems).not.toContain("amo_crm" as never);
    expect(activitySystems).not.toContain("jira" as never);
    expect(activitySystems).not.toContain("excel" as never);
    expect(activitySystems).not.toContain("telegram" as never);
    expect(activitySystems).not.toContain("tms" as never);
    expect(activitySystems).not.toContain("lms" as never);
  });
});
