import { describe, expect, it } from "vitest";
import {
  findQuickWin,
  quickWinAssignmentSchema,
  quickWinCatalog,
  quickWinIdSchema,
} from "../../../src/application/quick-wins.js";

const expectedIds = [
  "report_template",
  "data_import_export",
  "async_status",
  "checklist",
  "routing_rule",
  "waiting_sla",
  "batching",
  "mail_extraction",
  "priority_rule",
  "document_dispatch",
  "api_integration",
  "document_base",
  "ai_research",
  "ai_assistant_calc",
  "extraction_sorting",
  "technical_spec_review",
  "contract_template",
  "ai_image_generation",
  "bulk_mailing",
];

describe("SPEC-MINUTKA-QUICK-WINS-001: closed quick-win catalog", () => {
  it("contains exactly the accepted 19 unique catalog entries", () => {
    expect(quickWinCatalog).toHaveLength(19);
    expect(quickWinCatalog.map(({ id }) => id)).toEqual(expectedIds);
    expect(new Set(quickWinCatalog.map(({ id }) => id)).size).toBe(19);
  });

  it("keeps every catalog text field populated and enums closed", () => {
    for (const quickWin of quickWinCatalog) {
      expect(quickWin.typicalFor.trim()).not.toBe("");
      expect(quickWin.title.trim()).not.toBe("");
      expect(quickWin.whatChanges.trim()).not.toBe("");
      expect(quickWin.humanInTheLoop.trim()).not.toBe("");
      expect(quickWin.firstStep.trim()).not.toBe("");
      expect(["hours", "days", "weeks"]).toContain(quickWin.effort);
      expect(["employee", "internal_it", "with_algoritm"]).toContain(quickWin.whoCanDo);
      expect(quickWinIdSchema.parse(quickWin.id)).toBe(quickWin.id);
    }
  });

  it("accepts deep_dive as an assignment but never as a catalog id", () => {
    expect(quickWinAssignmentSchema.parse("deep_dive")).toBe("deep_dive");
    expect(quickWinIdSchema.safeParse("deep_dive").success).toBe(false);
    expect((quickWinCatalog as readonly { id: string }[]).some(({ id }) => id === "deep_dive")).toBe(false);
  });

  it("returns undefined for an unknown quick win", () => {
    expect(findQuickWin("not-a-quick-win")).toBeUndefined();
  });
});
