import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { activityCollectionItemSchema, collectActivitiesInputSchema } from "../../../src/contracts/minutka-activity.js";
import { collectActivitiesToolDescription } from "../../../src/mastra/tools/activity-collection-tool.js";

type ActivityFixture = {
  account: string;
  expected: Record<string, string>;
};

const pseudonymizedAccounts: ActivityFixture[] = [
  {
    account: "Участник провёл встречу с коллегами.",
    expected: { taskCategory: "meetings" },
  },
  {
    account: "Участник созвонился с подрядчиком; платформа не названа.",
    expected: { taskCategory: "communication" },
  },
  {
    account: "Участник подготовил шаблон для следующего рабочего этапа, препятствий не назвал.",
    expected: { taskCategory: "focus_work" },
  },
  {
    account: "Участник работал в явно названной внутренней системе, тип которой отсутствует в словаре.",
    expected: { taskCategory: "admin", system: "other" },
  },
  {
    account: "Участник назвал явное повторяющееся препятствие, не покрытое словарём routine patterns.",
    expected: { taskCategory: "coordination", routinePattern: "other" },
  },
  {
    account: "Участник назвал явную возможность автоматизации, не покрытую словарём automation candidates.",
    expected: { taskCategory: "focus_work", automationCandidate: "other" },
  },
];

describe("SPEC-MINUTKA-ACTIVITY-OMITTED-VS-OTHER-001: absence is not a taxonomy misfit", () => {
  it.each(pseudonymizedAccounts)("keeps the closed extraction for: $account", ({ expected }) => {
    const parsed = activityCollectionItemSchema.parse(expected);

    expect(parsed).toEqual(expected);
    expect(collectActivitiesInputSchema.parse({ activities: [expected] })).toEqual({ activities: [expected] });
  });

  it("distinguishes unnamed facts from explicit out-of-dictionary facts", () => {
    const [meeting, call, template, unknownSystem, unknownRoutine, unknownAutomation] = pseudonymizedAccounts
      .map(({ expected }) => activityCollectionItemSchema.parse(expected));

    for (const ordinaryActivity of [meeting, call, template]) {
      expect(ordinaryActivity).not.toHaveProperty("system", "other");
      expect(ordinaryActivity).not.toHaveProperty("routinePattern", "other");
      expect(ordinaryActivity).not.toHaveProperty("automationCandidate", "other");
      expect(ordinaryActivity).not.toHaveProperty("energyStressMarker");
    }
    expect(unknownSystem).toMatchObject({ system: "other" });
    expect(unknownRoutine).toMatchObject({ routinePattern: "other" });
    expect(unknownAutomation).toMatchObject({ automationCandidate: "other" });
  });

  it("gives the active and reference processes the same decision rule as the tool", () => {
    const morningProcess = readFileSync("vault/assistant/processes/morning_activity_collection.md", "utf8");
    const eveningProcess = readFileSync("vault/assistant/processes/evening_reflection.md", "utf8");

    for (const instructions of [morningProcess, eveningProcess, collectActivitiesToolDescription]) {
      expect(instructions).toContain("other");
      expect(instructions).toMatch(/omit/i);
      expect(instructions).toMatch(/meeting or call|meeting, call|meetings, calls/i);
      expect(instructions).toMatch(/no (system|obstacle)|has no (system|obstacle)/i);
    }
    for (const instructions of [morningProcess, eveningProcess, collectActivitiesToolDescription]) {
      expect(instructions).toMatch(/energyStressMarker.*no other|energy\/stress(?: (?:marker|facet))?.*no `?other`?/i);
    }
  });

  it("keeps the provider-visible input closed and free of explanatory text", () => {
    const jsonSchema = collectActivitiesInputSchema["~standard"].jsonSchema.input({ target: "draft-07" }) as {
      properties?: { activities?: { items?: { properties?: Record<string, unknown>; additionalProperties?: boolean } } };
    };
    const item = jsonSchema.properties?.activities?.items;

    expect(Object.keys(item?.properties ?? {}).sort()).toEqual([
      "automationCandidate",
      "durationBucket",
      "energyStressMarker",
      "routinePattern",
      "system",
      "taskCategory",
    ]);
    expect(item?.additionalProperties).toBe(false);
    expect(activityCollectionItemSchema.safeParse({
      taskCategory: "meetings",
      systemName: "внутренняя система",
      obstacleText: "явное препятствие вне словаря",
    }).success).toBe(false);
  });
});
