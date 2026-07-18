import { describe, expect, it } from "vitest";
import {
  applyContextBudget,
  assertContextSourceContentFits,
  contextBudgetConfigFromEnv,
  countUnicodeCharacters,
  createContextBudgetConfig,
  defaultContextBudget,
  type ContextSourceId,
} from "../../../src/application/context-budget.js";
import { assistantContextLimits } from "../../../src/application/assistant-context-projection.js";
import { assistantRecordsLimits } from "../../../src/application/assistant-records-projection.js";
import { AssistantService, buildAssistantSystemContext, type AssistantOperationalWarning } from "../../../src/application/assistant-service.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { conversationContextLimits } from "../../../src/application/conversation-context-limits.js";
import { documentReadLimits } from "../../../src/application/document-reader.js";
import { runtimeProjectionLimits } from "../../../src/application/runtime-projections/runtime-projection-limits.js";
import { maxChatInputCharacters } from "../../../src/shared/chat-limits.js";

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
      total: maxChatInputCharacters + 8,
      responseReserve: 2,
      sources: { base_instructions: 1, agent_manual: 3, profile: 10, context: 10, records: 10, inbox: 10, history: 10, actions: 10 },
      projectionLimits: { contextDocumentCharacters: 10, recordCharacters: 10, historyTurnCharacters: 10 },
    });
    const exact = applyContextBudget({
      config,
      userInput: "🙂".repeat(maxChatInputCharacters),
      sections: [
        { sourceId: "base_instructions", content: "A" },
        { sourceId: "agent_manual", content: "🙂🙂🙂" },
      ],
    });
    expect(exact.text).toBe("A\n\n🙂🙂🙂");
    expect(exact.used).toBe(6);
    expect(exact.available).toBe(6);
    expect(() => applyContextBudget({ ...exactInput(config), userInput: "🙂".repeat(maxChatInputCharacters + 1) })).toThrow("exceeds the 4096-character maximum");
  });

  it("never lets lower-priority owner data displace trusted control-plane content", () => {
    const config = createContextBudgetConfig({
      total: maxChatInputCharacters + 12,
      responseReserve: 0,
      sources: { base_instructions: 0, agent_manual: 7, profile: 12, context: 12, records: 12, inbox: 12, history: 12, actions: 12 },
      projectionLimits: { contextDocumentCharacters: 12, recordCharacters: 12, historyTurnCharacters: 12 },
    });
    const result = applyContextBudget({
      config,
      userInput: "x".repeat(maxChatInputCharacters),
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
      total: maxChatInputCharacters + 10,
      responseReserve: 0,
      sources: { base_instructions: 0, agent_manual: 0, profile: 10, context: 10, records: 10, inbox: 10, history: 10, actions: 10 },
      projectionLimits: { contextDocumentCharacters: 10, recordCharacters: 10, historyTurnCharacters: 10 },
    });
    const result = applyContextBudget({
      config,
      userInput: "x".repeat(maxChatInputCharacters),
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
      total: maxChatInputCharacters + 55,
      responseReserve: 5,
      sources: { base_instructions: 36, agent_manual: 7, profile: 55, context: 55, records: 55, inbox: 55, history: 55, actions: 55 },
      projectionLimits: { contextDocumentCharacters: 55, recordCharacters: 55, historyTurnCharacters: 55 },
    });
    const result = buildAssistantSystemContext(projection, undefined, "TRUSTED", undefined, undefined, "🙂".repeat(maxChatInputCharacters), config);
    expect(result).toContain("# Personal assistant runtime context");
    expect(result).toContain("TRUSTED");
    expect(countUnicodeCharacters(result)).toBeLessThanOrEqual(50);
  });

  it("emits a sanitized warning only when chat context sections are omitted", async () => {
    const overflowingWarnings: AssistantOperationalWarning[] = [];
    const overflowing = await createService({
      contextBudget: warningSpecBudget({ total: 5_000, context: 4_800 }),
      operationalLogger: (warning) => overflowingWarnings.push(warning),
      contextDocument: "private owner context".repeat(240),
    });
    await overflowing.chat({ userId: "owner", threadId: "thread", text: "request" });

    expect(overflowingWarnings).toHaveLength(1);
    expect(overflowingWarnings[0]).toEqual({
      type: "context_budget_overflow",
      omittedSourceIds: ["context"],
      used: expect.any(Number),
      available: expect.any(Number),
    });
    expect(Object.keys(overflowingWarnings[0] ?? {}).sort()).toEqual(["available", "omittedSourceIds", "type", "used"]);

    const happyPathWarnings: AssistantOperationalWarning[] = [];
    const happyPath = await createService({
      contextBudget: warningSpecBudget({ total: 10_000, context: 4_800 }),
      operationalLogger: (warning) => happyPathWarnings.push(warning),
      contextDocument: "private owner context".repeat(240),
    });
    await happyPath.chat({ userId: "owner", threadId: "thread", text: "request" });
    expect(happyPathWarnings).toEqual([]);
  });

  it("rejects context budgets that cannot hold trusted ceilings at maximum input", () => {
    expect(() => createContextBudgetConfig({
      total: 10_000,
      responseReserve: 1_000,
      sources: { base_instructions: 2_000, agent_manual: 3_000, context: 10_000, records: 10_000, history: 10_000 },
      projectionLimits: { contextDocumentCharacters: 10_000, recordCharacters: 10_000, historyTurnCharacters: 10_000 },
    })).toThrow("trusted context ceilings (5002) plus maximum user input (4096) and response reserve (1000) must not exceed total budget (10000)");
  });

  it("fails fast when loaded trusted content exceeds its configured ceiling", () => {
    const config = createContextBudgetConfig({
      total: 10_000,
      responseReserve: 1_000,
      sources: { base_instructions: 1_000, agent_manual: 3_000, context: 10_000, records: 10_000, history: 10_000 },
      projectionLimits: { contextDocumentCharacters: 10_000, recordCharacters: 10_000, historyTurnCharacters: 10_000 },
    });
    expect(() => assertContextSourceContentFits({
      config,
      sourceId: "agent_manual",
      content: "🙂".repeat(3_001),
      label: "loaded assistant agent manual",
    })).toThrow("loaded assistant agent manual has 3001 Unicode characters and exceeds the 3000-character agent_manual ceiling");
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

function warningSpecBudget(input: { total: number; context: number }) {
  const sources: Partial<Record<ContextSourceId, number>> = {
    base_instructions: 36,
    agent_manual: 600,
    profile: input.total,
    context: input.context,
    records: input.total,
    inbox: input.total,
    history: input.total,
    actions: input.total,
  };
  return createContextBudgetConfig({
    total: input.total,
    responseReserve: 0,
    sources,
    projectionLimits: { contextDocumentCharacters: input.context, recordCharacters: input.total, historyTurnCharacters: input.total },
  });
}

async function createService(input: { contextBudget: ReturnType<typeof createContextBudgetConfig>; operationalLogger: (warning: AssistantOperationalWarning) => void; contextDocument: string }) {
  const world = createInMemoryWorld(() => "2026-07-18T00:00:00.000Z");
  const documentStore = createInMemoryDocumentStore({ now: world.now });
  const ingestionService = createIngestionService({ documentStore, blobStore: createInMemoryBlobStore({ now: world.now }) });
  await ingestionService.saveContextDocument({ userId: "owner", path: "context/private.md", content: input.contextDocument });
  return new AssistantService(async () => "ok", {
    documentStore,
    conversationStore: createInMemoryConversationStore(world),
    ingestionService,
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock: { now: world.now },
    agentInstructions: "manual",
    contextBudget: input.contextBudget,
    operationalLogger: input.operationalLogger,
  });
}
