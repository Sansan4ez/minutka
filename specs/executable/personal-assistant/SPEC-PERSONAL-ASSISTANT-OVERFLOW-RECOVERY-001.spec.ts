import { describe, expect, it } from "vitest";
import {
  AssistantContextOverflowError,
  classifyProviderContextOverflow,
  createOverflowRecoveryContextBudget,
} from "../../../src/application/assistant-overflow-recovery.js";
import { AssistantService, type AssistantAgentContext } from "../../../src/application/assistant-service.js";
import { createContextBudgetConfig, defaultContextBudget, sourceCharacterCeiling } from "../../../src/application/context-budget.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import type { ChatProcSnapshot } from "../../../src/application/runtime-projections/runtime-projection-types.js";

const now = "2026-07-26T22:00:00.000Z";
const coreManifest = {
  version: 1 as const,
  rules: [{ id: "core", pattern: "^/proc/context/core\\.md$", matcher: /^\/proc\/context\/core\.md$/u }],
};

function setup(runner: ConstructorParameters<typeof AssistantService>[0]) {
  const world = createInMemoryWorld(() => now);
  const documents = createInMemoryDocumentStore({ now: world.now }, [
    { userId: "owner", path: "context/core.md", content: "CORE" },
    { userId: "owner", path: "context/reference.md", content: "REFERENCE" },
  ]);
  const ideas = createInMemoryIdeaStore({ now: world.now });
  const ingestion = createIngestionService({
    documentStore: documents,
    blobStore: createInMemoryBlobStore({ now: world.now }),
    ideaStore: ideas,
  });
  const profileAndHistory = snapshot();
  const service = new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(world),
    ingestionService: ingestion,
    ideaStore: ideas,
    auditEventStore: createInMemoryAuditEventStore(world),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    chatProjectionBuilder: { async buildChatProc() { return { snapshot: profileAndHistory }; } },
    contextPriorities: coreManifest,
    clock: { now: world.now },
    idGenerator: {
      requestId: () => "req-overflow", messageId: () => "msg-overflow", insightId: () => "ins", feedbackId: () => "fb",
      ideaId: () => "idea-overflow", auditEventId: () => `evt-${world.auditEvents.length + 1}`,
    },
  });
  return { service, ideas, world, documents };
}

function snapshot(): ChatProcSnapshot {
  const scope = { employeeId: "owner", threadId: "thread", requestId: "req-overflow", purpose: "chat" as const };
  return {
    profile: {
      schemaVersion: 1, path: "/proc/profile", generatedAt: now, scope,
      data: { preferredName: "Владелец", assistantName: "Помощник", addressForm: "informal", persona: "efficiency", responseLength: "balanced", timezone: "Etc/UTC" },
    },
    thread: {
      schemaVersion: 1, path: "/proc/thread", generatedAt: now, scope,
      data: {
        turns: Array.from({ length: 8 }, (_, index) => ({
          messageId: `old-${index}`, employeeId: "owner", threadId: "thread",
          userText: `HISTORY-${index}-${"u".repeat(350)}`, agentResponse: `ANSWER-${index}-${"a".repeat(350)}`, timestamp: now,
        })),
        truncated: false,
      },
    },
  };
}

function overflowError(): Error {
  return new Error("This model's maximum context length is 128000 tokens. Please reduce the length of the messages.");
}

describe("SPEC-PERSONAL-ASSISTANT-OVERFLOW-RECOVERY-001: one-shot provider context recovery", () => {
  it("retries once with reduced low-priority context and audits ceilings without text", async () => {
    const contexts: AssistantAgentContext[] = [];
    const { service, ideas, world } = setup(async (_input, context) => {
      contexts.push(context);
      if (contexts.length === 1) throw overflowError();
      return "Восстановлено.";
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "Продолжи работу" })).resolves.toMatchObject({
      response: "Восстановлено.", selectedProcessIds: ["core"],
    });

    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.systemContext).toContain("HISTORY-0");
    expect(contexts[1]?.systemContext).not.toContain("HISTORY-0");
    expect(contexts[1]?.systemContext).toContain("HISTORY-7");
    expect(contexts[1]?.systemContext).toContain("CORE");
    expect(contexts[1]?.systemContext).toContain("## Machine index: /proc/context");
    expect(contexts[0]?.personalContext.scope).toEqual(contexts[1]?.personalContext.scope);
    expect(contexts[1]?.personalContext.data.index.text.length).toBeLessThanOrEqual(3_000);
    await expect(ideas.list("owner")).resolves.toEqual([]);

    const recovery = world.auditEvents.find(({ type }) => type === "overflow_recovery");
    expect(recovery?.metadata).toEqual({
      reason: "context_length_exceeded", attempt: 1, recordsCeiling: 3_000, historyCeiling: 3_000, contextIndexCeiling: 3_000,
    });
    expect(JSON.stringify(recovery)).not.toContain("Продолжи работу");
    expect(JSON.stringify(recovery)).not.toContain("HISTORY");
  });

  it("returns a typed error after the single retry while fallback capture preserves owner input", async () => {
    let calls = 0;
    const { service, ideas, world } = setup(async () => { calls += 1; throw overflowError(); });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "Не потеряй этот ввод" }))
      .rejects.toMatchObject({ name: "AssistantContextOverflowError", code: "context_overflow", reason: "context_length_exceeded" });
    expect(calls).toBe(2);
    await expect(ideas.list("owner")).resolves.toMatchObject([{ id: "idea-overflow", summary: "Не потеряй этот ввод" }]);
    expect(world.auditEvents.filter(({ type }) => type === "overflow_recovery")).toHaveLength(1);
    expect(world.auditEvents.filter(({ type }) => type === "idea_captured")).toHaveLength(1);
    expect(world.messages).toEqual([]);
  });

  it.each([
    new Error("429 Too Many Requests: rate limit exceeded"),
    { message: "request throttled", status: 529 },
    new Error("fetch failed: ECONNRESET"),
  ])("does not retry non-overflow provider errors", async (failure) => {
    let calls = 0;
    const { service, ideas, world } = setup(async () => { calls += 1; throw failure; });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "Сохрани при сетевом сбое" })).resolves.toMatchObject({
      selectedProcessIds: ["core", "inbox_capture"], response: expect.stringContaining("К какому проекту"),
    });
    expect(calls).toBe(1);
    expect(world.auditEvents.some(({ type }) => type === "overflow_recovery")).toBe(false);
    await expect(ideas.list("owner")).resolves.toHaveLength(1);
  });

  it("classifies nested Mastra surfaces, excludes throttling, and validates the reduced preset canonically", () => {
    expect(classifyProviderContextOverflow({
      message: "Mastra generation failed",
      cause: { error: { type: "invalid_request_error", code: "context_length_exceeded", message: "input is too long" } },
    })).toBe("context_length_exceeded");
    expect(classifyProviderContextOverflow({ status: 429, message: "maximum context length mentioned by a rate limit wrapper" })).toBeUndefined();

    const reduced = createOverflowRecoveryContextBudget(defaultContextBudget);
    expect(reduced).toEqual(createContextBudgetConfig({
      total: defaultContextBudget.total,
      responseReserve: defaultContextBudget.responseReserve,
      sources: Object.fromEntries(defaultContextBudget.sources.map((source) => [source.id,
        source.id === "records" || source.id === "history" || source.id === "context_index" ? 3_000 : source.ceiling,
      ])),
      projectionLimits: { ...defaultContextBudget.projectionLimits, contextIndexDepth: 2, records: 8, historyTurns: 4, historyTurnCharacters: 3_000 },
      documentTools: { ...defaultContextBudget.documentTools },
    }));
    for (const id of ["base_instructions", "agent_manual", "profile", "context", "thread_summary"] as const) {
      expect(sourceCharacterCeiling(reduced, id)).toBe(sourceCharacterCeiling(defaultContextBudget, id));
    }
    expect(new AssistantContextOverflowError("prompt_too_long")).toMatchObject({ code: "context_overflow", reason: "prompt_too_long" });
  });
});
