import { describe, expect, it } from "vitest";
import {
  activityDurationBucketSchema,
  activitySystemSchema,
  collectActivityInputSchema,
} from "../../../src/contracts/minutka-activity.js";
import {
  activityDurationBuckets,
  activitySystems,
  automationCandidateTypes,
  energyStressMarkerTypes,
  routinePatternTypes,
  taskCategories,
} from "../../../src/domain/insights.js";

const expectedFields = [
  "taskCategory",
  "routinePattern",
  "automationCandidate",
  "energyStressMarker",
  "durationBucket",
  "system",
];

describe("SPEC-MINUTKA-ACTIVITY-CONTRACT-001: typed activity collection", () => {
  it("accepts exactly the closed dictionaries used by the anonymized trace", () => {
    expect(taskCategories).toHaveLength(8);
    expect(routinePatternTypes).toHaveLength(7);
    expect(automationCandidateTypes).toHaveLength(7);
    expect(energyStressMarkerTypes).toHaveLength(6);
    expect(activityDurationBuckets).toEqual(["lt_15m", "15_30m", "30_60m", "1_2h", "2_4h", "gt_4h"]);
    expect(activitySystems).toEqual([
      "bitrix24",
      "one_c",
      "spreadsheets",
      "email",
      "messengers",
      "crm",
      "task_tracker",
      "telephony",
      "tender_platform",
      "logistics_system",
      "learning_platform",
      "paper_or_verbal",
      "other",
    ]);

    for (const value of activityDurationBuckets) expect(activityDurationBucketSchema.parse(value)).toBe(value);
    for (const value of activitySystems) expect(activitySystemSchema.parse(value)).toBe(value);
  });

  it("rejects arbitrary category, duration, and system strings", () => {
    expect(collectActivityInputSchema.safeParse({ taskCategory: "making_coffee" }).success).toBe(false);
    expect(collectActivityInputSchema.safeParse({ routinePattern: "too_many_tabs" }).success).toBe(false);
    expect(collectActivityInputSchema.safeParse({ automationCandidate: "write_a_script" }).success).toBe(false);
    expect(collectActivityInputSchema.safeParse({ energyStressMarker: "annoyed" }).success).toBe(false);
    expect(collectActivityInputSchema.safeParse({ durationBucket: "40m" }).success).toBe(false);
    expect(collectActivityInputSchema.safeParse({ system: "Zoom" }).success).toBe(false);
  });

  it("has no free-text fields and rejects unknown keys", () => {
    const jsonSchema = collectActivityInputSchema["~standard"].jsonSchema.input({ target: "draft-07" }) as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };

    expect(Object.keys(jsonSchema.properties ?? {}).sort()).toEqual([...expectedFields].sort());
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(collectActivityInputSchema.safeParse({ label: "планёрка" }).success).toBe(false);
    expect(collectActivityInputSchema.safeParse({ rationale: "можно автоматизировать" }).success).toBe(false);
    expect(collectActivityInputSchema.safeParse({ interferesWith: "работой" }).success).toBe(false);
  });

  it("models one activity with a category and one optional obstacle", () => {
    const parsed = collectActivityInputSchema.parse({
      taskCategory: "reporting",
      routinePattern: "manual_reporting",
      durationBucket: "1_2h",
      system: "spreadsheets",
    });

    expect(parsed).toEqual({
      taskCategory: "reporting",
      routinePattern: "manual_reporting",
      durationBucket: "1_2h",
      system: "spreadsheets",
    });
    expect(collectActivityInputSchema.safeParse({ activities: [parsed] }).success).toBe(false);
  });

  it("carries no constraint the provider schema cannot show the model", () => {
    // A cross-field rule survives zod but vanishes from the JSON Schema the
    // model reads, so every call it rejects is a lost daily touch. The «at most
    // one obstacle» rule therefore lives in the tool description, and one
    // obstacle per stored activity is enforced by CollectActivityService.
    expect((collectActivityInputSchema as unknown as { _zod: { def: { checks?: unknown[] } } })._zod.def.checks ?? [])
      .toEqual([]);
    expect(collectActivityInputSchema.safeParse({
      taskCategory: "reporting",
      routinePattern: "manual_reporting",
      automationCandidate: "report_generation",
      energyStressMarker: "neutral",
      durationBucket: "1_2h",
      system: "spreadsheets",
    }).success).toBe(true);
  });

  it("accepts incomplete activities and never inserts defaults", () => {
    expect(collectActivityInputSchema.parse({})).toEqual({});
    expect(collectActivityInputSchema.parse({ taskCategory: "reporting" })).toEqual({ taskCategory: "reporting" });
    expect(collectActivityInputSchema.parse({ durationBucket: "1_2h" })).toEqual({ durationBucket: "1_2h" });
    expect(collectActivityInputSchema.parse({ system: "spreadsheets" })).toEqual({ system: "spreadsheets" });
  });
});
