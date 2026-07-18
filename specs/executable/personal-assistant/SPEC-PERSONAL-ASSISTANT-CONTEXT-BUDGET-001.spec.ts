import { describe, expect, it } from "vitest";
import {
  applyContextBudget,
  contextBudgetConfigFromEnv,
  countUnicodeCharacters,
  createContextBudgetConfig,
  defaultContextBudget,
} from "../../../src/application/context-budget.js";
import { assistantContextLimits } from "../../../src/application/assistant-context-projection.js";
import { assistantRecordsLimits } from "../../../src/application/assistant-records-projection.js";
import { buildAssistantSystemContext } from "../../../src/application/assistant-service.js";
import { conversationContextLimits } from "../../../src/application/conversation-context-limits.js";
import { documentReadLimits } from "../../../src/application/document-reader.js";
import { runtimeProjectionLimits } from "../../../src/application/runtime-projections/runtime-projection-limits.js";

const projection = {
  schemaVersion: 1 as const,
  path: "/proc/context" as const,
  generatedAt: "2026-07-17T00:00:00.000Z",
  scope: { userId: "owner", requestId: "request" },
  data: { documents: [], truncated: false },
};

describe("SPEC-PERSONAL-ASSISTANT-CONTEXT-BUDGET-001: unified request context budget", () => {
  it("keeps the documented defaults as the single source for legacy limit exports", () => {
    expect(defaultContextBudget.total).toBe(48_000);
    expect(defaultContextBudget.sources.map(({ id }) => id)).toEqual([
      "base_instructions", "agent_manual", "profile", "context", "records", "inbox", "history", "actions",
    ]);
    expect(assistantContextLimits).toEqual({ documents: 12, characters: 16_000, documentCharacters: 4_000 });
    expect(assistantRecordsLimits).toEqual({ records: 24, characters: 12_000, recordCharacters: 1_000 });
    expect(conversationContextLimits).toMatchObject({ responseTurns: 10, responseCharacters: 12_000, responseFieldCharacters: 6_000 });
    expect(runtimeProjectionLimits).toMatchObject({ threadTurns: 10, threadCharacters: 12_000, threadTurnTextCharacters: 6_000 });
    expect(documentReadLimits).toEqual({
      listDefault: 20, listMaximum: 50, readDefaultCharacters: 4_000, readMaximumCharacters: 8_000,
      searchDefault: 10, searchMaximum: 20, searchSnippetCharacters: 500,
    });
  });

  it("counts Unicode code points and reserves input plus response space at the boundary", () => {
    expect(countUnicodeCharacters("🙂a")).toBe(2);
    const config = createContextBudgetConfig({
      total: 10,
      responseReserve: 2,
      sources: { base_instructions: 10, agent_manual: 10, profile: 10, context: 10, records: 10, inbox: 10, history: 10, actions: 10 },
      projectionLimits: { contextDocumentCharacters: 10, recordCharacters: 10, historyTurnCharacters: 10 },
    });
    const exact = applyContextBudget({
      config,
      userInput: "🙂🙂",
      sections: [
        { sourceId: "base_instructions", content: "A" },
        { sourceId: "agent_manual", content: "🙂🙂🙂" },
      ],
    });
    expect(exact.text).toBe("A\n\n🙂🙂🙂");
    expect(exact.used).toBe(6);
    expect(exact.available).toBe(6);
    expect(() => applyContextBudget({ ...exactInput(config), userInput: "🙂".repeat(9) })).toThrow("exceed the total context budget");
  });

  it("never lets lower-priority owner data displace trusted control-plane content", () => {
    const config = createContextBudgetConfig({
      total: 12,
      responseReserve: 0,
      sources: { base_instructions: 12, agent_manual: 12, profile: 12, context: 12, records: 12, inbox: 12, history: 12, actions: 12 },
      projectionLimits: { contextDocumentCharacters: 12, recordCharacters: 12, historyTurnCharacters: 12 },
    });
    const result = applyContextBudget({
      config,
      userInput: "",
      sections: [
        { sourceId: "records", content: "records" },
        { sourceId: "agent_manual", content: "trusted" },
        { sourceId: "context", content: "owner" },
      ],
    });
    expect(result.text).toBe("trusted");
    expect(result.omittedSourceIds).toEqual(["context", "records"]);
  });

  it("omits every lower-priority section after the first owner section overflows", () => {
    const config = createContextBudgetConfig({
      total: 10,
      responseReserve: 0,
      sources: { base_instructions: 10, agent_manual: 10, profile: 10, context: 10, records: 10, inbox: 10, history: 10, actions: 10 },
      projectionLimits: { contextDocumentCharacters: 10, recordCharacters: 10, historyTurnCharacters: 10 },
    });
    const result = applyContextBudget({
      config,
      userInput: "",
      sections: [
        { sourceId: "context", content: "owner" },
        { sourceId: "records", content: "records" },
        { sourceId: "history", content: "h" },
      ],
    });
    expect(result.text).toBe("owner");
    expect(result.used).toBe(5);
    expect(result.omittedSourceIds).toEqual(["records", "history"]);
  });

  it("applies the aggregate budget at the buildAssistantSystemContext seam", () => {
    const config = createContextBudgetConfig({
      total: 55,
      responseReserve: 5,
      sources: { base_instructions: 55, agent_manual: 55, profile: 55, context: 55, records: 55, inbox: 55, history: 55, actions: 55 },
      projectionLimits: { contextDocumentCharacters: 55, recordCharacters: 55, historyTurnCharacters: 55 },
    });
    const result = buildAssistantSystemContext(projection, undefined, "TRUSTED", undefined, undefined, "🙂".repeat(5), config);
    expect(result).toContain("# Personal assistant runtime context");
    expect(result).toContain("TRUSTED");
    expect(countUnicodeCharacters(result)).toBeLessThanOrEqual(45);
  });

  it("parses environment overrides and fails fast on invalid or contradictory values", () => {
    expect(contextBudgetConfigFromEnv({
      ASSISTANT_CONTEXT_TOTAL_CHARACTERS: "50000",
      ASSISTANT_CONTEXT_RESPONSE_RESERVE_CHARACTERS: "9000",
      ASSISTANT_CONTEXT_SOURCE_CONTEXT_CHARACTERS: "17000",
      ASSISTANT_CONTEXT_DOCUMENT_CHARACTERS: "5000",
      ASSISTANT_DOCUMENT_READ_MAXIMUM_CHARACTERS: "9000",
    })).toMatchObject({
      total: 50_000,
      responseReserve: 9_000,
      projectionLimits: { contextDocumentCharacters: 5_000 },
      documentTools: { readMaximumCharacters: 9_000 },
    });
    expect(() => contextBudgetConfigFromEnv({ ASSISTANT_CONTEXT_TOTAL_CHARACTERS: "-1" })).toThrow("non-negative integer");
    expect(() => contextBudgetConfigFromEnv({ ASSISTANT_CONTEXT_TOTAL_CHARACTERS: "1000" })).toThrow("must not exceed total budget");
    expect(() => createContextBudgetConfig({ sources: { missing: 1 } as never })).toThrow("unknown context budget source");
  });
});

function exactInput(config: ReturnType<typeof createContextBudgetConfig>) {
  return { config, userInput: "", sections: [{ sourceId: "agent_manual" as const, content: "x" }] };
}
