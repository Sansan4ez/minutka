import { describe, expect, it } from "vitest";
import {
  DurationEvidenceValidationError,
  extractDurationEvidence,
  MAX_DURATION_REFERENCES,
  RequestDurationEvidence,
} from "../../../src/application/activity-duration-evidence.js";

function buckets(text: string) {
  return extractDurationEvidence(text).map(({ ref, bucket, sourceOrder }) => ({ ref, bucket, sourceOrder }));
}

describe("SPEC-MINUTKA-DURATION-EVIDENCE-001: request-local explicit duration evidence", () => {
  it.each([
    ["14 минут", "lt_15m"],
    ["15 минут", "15_30m"],
    ["30 минут", "15_30m"],
    ["35 минут", "30_60m"],
    ["35-минутную встречу", "30_60m"],
    ["60 минут", "30_60m"],
    ["61 минута", "1_2h"],
    ["2 часа", "1_2h"],
    ["2-часовой созвон", "1_2h"],
    ["4 часа", "2_4h"],
    ["5 часов", "gt_4h"],
    ["полчаса", "15_30m"],
    ["примерно полтора часа", "1_2h"],
    ["полтора часа", "1_2h"],
    ["около полторы часа", "1_2h"],
    ["35 minutes", "30_60m"],
    ["2 hours", "1_2h"],
    ["half an hour", "15_30m"],
  ] as const)("normalizes %s to %s", (text, bucket) => {
    expect(buckets(text)).toEqual([{ ref: "duration_1", bucket, sourceOrder: 0 }]);
  });

  it("keeps repeated expressions as separate ordered refs across Unicode whitespace", () => {
    expect(buckets("35\u00a0минут, затем 35\u202fминут и 2\tчаса")).toEqual([
      { ref: "duration_1", bucket: "30_60m", sourceOrder: 0 },
      { ref: "duration_2", bucket: "30_60m", sourceOrder: 1 },
      { ref: "duration_3", bucket: "1_2h", sourceOrder: 2 },
    ]);
  });

  it("caps request-local references at the shared extractor limit", () => {
    const text = Array.from({ length: MAX_DURATION_REFERENCES + 1 }, (_, index) => `Задача ${index + 1}: 5 мин.`).join(" ");
    const evidence = extractDurationEvidence(text);

    expect(evidence).toHaveLength(MAX_DURATION_REFERENCES);
    expect(evidence.at(-1)).toEqual({ ref: "duration_32", bucket: "lt_15m", sourceOrder: 31 });
  });

  it.each([
    ["1 час 20 минут", "1_2h"],
    ["2 часа 15 минут", "2_4h"],
  ] as const)("merges compound hour-to-minute expression %s into %s", (text, bucket) => {
    expect(buckets(text)).toEqual([{ ref: "duration_1", bucket, sourceOrder: 0 }]);
  });

  it("keeps reverse minute-to-hour order as separate refs", () => {
    expect(buckets("20 минут и 1 час")).toEqual([
      { ref: "duration_1", bucket: "15_30m", sourceOrder: 0 },
      { ref: "duration_2", bucket: "30_60m", sourceOrder: 1 },
    ]);
  });

  it.each([
    "работал долго",
    "почти весь день",
    "заняло несколько часов",
    "примерно часик",
    "35 задач",
    "about an hour",
  ])("omits ambiguous or unrecognized wording: %s", (text) => {
    expect(extractDurationEvidence(text)).toEqual([]);
  });

  it("resolves refs mechanically, consumes only saved rows, and never persists refs", () => {
    const evidence = new RequestDurationEvidence(extractDurationEvidence("35 минут и 2 часа"));
    const first = evidence.prepareCollection({ activities: [
      { taskCategory: "meetings", durationRef: "duration_1" },
      { taskCategory: "reporting", durationRef: "duration_2" },
    ] });
    expect(first.input).toEqual({ activities: [
      { taskCategory: "meetings", durationBucket: "30_60m" },
      { taskCategory: "reporting", durationBucket: "1_2h" },
    ] });
    expect(JSON.stringify(first.input)).not.toContain("durationRef");

    evidence.consumeCollection(first.refsByActivity, 1);
    expect(() => evidence.prepareCollection({ activities: [{ taskCategory: "meetings", durationRef: "duration_1" }] }))
      .toThrow(new DurationEvidenceValidationError("duration_ref_already_used"));
    expect(evidence.prepareCollection({ activities: [{ taskCategory: "reporting", durationRef: "duration_2" }] }).input)
      .toEqual({ activities: [{ taskCategory: "reporting", durationBucket: "1_2h" }] });
    expect(() => evidence.prepareCollection({ activities: [{ taskCategory: "admin", durationRef: "duration_99" }] }))
      .toThrow(new DurationEvidenceValidationError("unknown_duration_ref"));
  });

  it("returns bounded structured detail for duplicate reuse without source text", async () => {
    const { createCollectActivitiesTool } = await import("../../../src/mastra/tools/activity-collection-tool.js");
    const evidence = new RequestDurationEvidence(extractDurationEvidence("примерно полтора часа"));
    const tool = createCollectActivitiesTool(async ({ activities }) => ({
      status: "completed", savedCount: activities.length, activityIds: [],
    }), evidence);
    await expect(tool.execute?.({ activities: [
      { taskCategory: "meetings", durationRef: "duration_1" },
      { taskCategory: "focus_work", durationRef: "duration_1" },
    ] }, {} as never)).resolves.toEqual({
      status: "failed", savedCount: 0, validation: { code: "duration_ref_already_used" },
    });
    expect(JSON.stringify(await tool.execute?.({ activities: [
      { taskCategory: "meetings", durationRef: "duration_1" },
      { taskCategory: "focus_work", durationRef: "duration_1" },
    ] }, {} as never))).not.toContain("полтора");
  });

  it("rejects duplicating one phrase in a batch while preserving factual rows when duration is omitted", () => {
    const evidence = new RequestDurationEvidence(extractDurationEvidence("примерно полтора часа"));
    expect(() => evidence.prepareCollection({ activities: [
      { taskCategory: "meetings", durationRef: "duration_1" },
      { taskCategory: "focus_work", durationRef: "duration_1" },
    ] })).toThrow(new DurationEvidenceValidationError("duration_ref_already_used"));
    expect(evidence.prepareCollection({ activities: [
      { taskCategory: "meetings", durationRef: "duration_1" },
      { taskCategory: "focus_work" },
      { taskCategory: "reporting" },
      { taskCategory: "communication" },
      { taskCategory: "admin" },
    ] }).input).toEqual({ activities: [
      { taskCategory: "meetings", durationBucket: "1_2h" },
      { taskCategory: "focus_work" },
      { taskCategory: "reporting" },
      { taskCategory: "communication" },
      { taskCategory: "admin" },
    ] });
  });
});
