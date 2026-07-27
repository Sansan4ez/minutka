import { describe, expect, it } from "vitest";
import {
  AssistantContextOverflowError,
  classifyProviderContextOverflow,
  contextOverflowUserMessage,
  createOverflowRecoveryContextBudget,
  overflowAfterDurableWriteUserMessage,
  overflowRecoveryUserMessage,
} from "../../../src/application/assistant-overflow-recovery.js";
import {
  AssistantMutationOutcomeUnknownError,
  mutationOutcomeUnknownUserMessage,
  mutationOutcomeUserMessage,
} from "../../../src/application/assistant-mutation-outcome.js";
import { AssistantService, type AssistantAgentContext } from "../../../src/application/assistant-service.js";
import { createContextBudgetConfig, defaultContextBudget, sourceCharacterCeiling } from "../../../src/application/context-budget.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService, type IngestionService } from "../../../src/application/ingestion-service.js";
import { boundRecentHistory } from "../../../src/application/runtime-projections/runtime-projection-builder.js";
import { minimumRecentHistoryCharacters } from "../../../src/application/runtime-projections/runtime-projection-renderer.js";
import type { ChatProcSnapshot } from "../../../src/application/runtime-projections/runtime-projection-types.js";
import { MinutkaApiError } from "../../../src/client/sdk/http-transport.js";
import { mapError } from "../../../src/server/http/error-mapping.js";

const now = "2026-07-26T22:00:00.000Z";
const coreManifest = {
  version: 1 as const,
  rules: [{ id: "core", pattern: "^/proc/context/core\\.md$", matcher: /^\/proc\/context\/core\.md$/u }],
};

function setup(
  runner: ConstructorParameters<typeof AssistantService>[0],
  profileAndHistory = snapshot(),
  contextBudget = defaultContextBudget,
  options: { captureIdea?: IngestionService["captureIdea"]; ideaId?: () => string } = {},
) {
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
  const service = new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(world),
    ingestionService: options.captureIdea === undefined ? ingestion : { ...ingestion, captureIdea: options.captureIdea },
    ideaStore: ideas,
    auditEventStore: createInMemoryAuditEventStore(world),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    chatProjectionBuilder: { async buildChatProc() { return { snapshot: profileAndHistory }; } },
    contextPriorities: coreManifest,
    contextBudget,
    clock: { now: world.now },
    idGenerator: {
      requestId: () => "req-overflow", messageId: () => "msg-overflow", insightId: () => "ins", feedbackId: () => "fb",
      ideaId: options.ideaId ?? (() => "idea-overflow"), auditEventId: () => `evt-${world.auditEvents.length + 1}`,
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
    expect(contexts[1]?.documents).toBe(contexts[0]?.documents);
    expect(contexts[1]?.personalContext.data.index.text.length).toBeLessThanOrEqual(3_000);
    const reducedHistoryStart = contexts[1]?.systemContext.indexOf("## Runtime projection: /proc/thread") ?? -1;
    expect(reducedHistoryStart).toBeGreaterThanOrEqual(0);
    expect(Array.from(contexts[1]!.systemContext.slice(reducedHistoryStart)).length).toBeLessThanOrEqual(3_000);
    await expect(ideas.list("owner")).resolves.toEqual([]);

    const recovery = world.auditEvents.find(({ type }) => type === "overflow_recovery");
    expect(recovery?.metadata).toEqual({
      reason: "context_length_exceeded", attempt: 1, recordsCeiling: 3_000, historyCeiling: 3_000, contextIndexCeiling: 3_000,
    });
    expect(JSON.stringify(recovery)).not.toContain("Продолжи работу");
    expect(JSON.stringify(recovery)).not.toContain("HISTORY");
  });

  it("rebuilds adversarial escaped history within the reduced 3000-character ceiling", async () => {
    const escaped = snapshot();
    const normalBudget = createContextBudgetConfig({ sources: { history: 4_000 }, projectionLimits: { historyTurns: 4, historyTurnCharacters: 4_000 } });
    const escapedTurns = [{
      messageId: "escaped-newest", employeeId: "owner", threadId: "thread",
      userText: "<&>\"😀".repeat(1_000), agentResponse: "&&<<>>😀".repeat(800), timestamp: now,
    }];
    const bounded = boundRecentHistory(escapedTurns, { turns: 4, characters: 4_000, fieldCharacters: 4_000 });
    escaped.thread.data = bounded;
    const contexts: AssistantAgentContext[] = [];
    const { service } = setup(async (_input, context) => {
      contexts.push(context);
      if (contexts.length === 1) throw overflowError();
      return "Восстановлено.";
    }, escaped, normalBudget);

    await service.chat({ userId: "owner", threadId: "thread", text: "Продолжи" });
    const historyStart = contexts[1]!.systemContext.indexOf("## Runtime projection: /proc/thread");
    const renderedHistory = contexts[1]!.systemContext.slice(historyStart);
    expect(historyStart).toBeGreaterThanOrEqual(0);
    expect(Array.from(renderedHistory).length).toBeLessThanOrEqual(3_000);
    expect(contexts[1]!.profileAndHistory.thread.data.turns.map(({ messageId }) => messageId)).toEqual(["escaped-newest"]);
    expect(renderedHistory).toContain("&lt;");
    expect(renderedHistory).toContain("😀");
  });

  it("does not retry or fallback after a tool step committed a durable idea", async () => {
    let calls = 0;
    const { service, ideas, world } = setup(async (_input, context) => {
      calls += 1;
      await context.captureIdea({
        project: "АССИСТЕНТ",
        type: "development",
        summary: "Сохранить только один раз",
        suggestedNextStep: "Продолжить после сокращения запроса.",
        needsProjectClarification: false,
      });
      throw overflowError();
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "Запиши идею и продолжи" }))
      .rejects.toMatchObject({
        name: "AssistantContextOverflowError",
        code: "context_overflow",
        reason: "context_length_exceeded",
        durableEffectCommitted: true,
        message: expect.stringContaining("Идея уже сохранена"),
      });
    expect(calls).toBe(1);
    await expect(ideas.list("owner")).resolves.toMatchObject([{ id: "idea-overflow", summary: "Сохранить только один раз" }]);
    expect(world.auditEvents.filter(({ type }) => type === "overflow_recovery")).toHaveLength(0);
    expect(world.auditEvents.filter(({ type }) => type === "idea_captured")).toHaveLength(1);
    expect(world.messages).toEqual([]);
  });

  it("does not retry or fallback when a capture commits and then loses its result", async () => {
    let runnerCalls = 0;
    let captureCalls = 0;
    let nextIdea = 0;
    let committedCapture: IngestionService["captureIdea"] | undefined;
    const { service, ideas, world } = setup(async (_input, context) => {
      runnerCalls += 1;
      try {
        await context.captureIdea({
          project: "АССИСТЕНТ",
          type: "development",
          summary: "Commit happened before disconnect",
          suggestedNextStep: "Проверить список.",
          needsProjectClarification: false,
        });
      } catch {
        throw overflowError();
      }
      return "unreachable";
    }, snapshot(), defaultContextBudget, {
      ideaId: () => `idea-uncertain-${++nextIdea}`,
      captureIdea: async (input) => {
        captureCalls += 1;
        await committedCapture!(input);
        throw new Error("connection lost after commit");
      },
    });
    const baseIngestion = createIngestionService({
      documentStore: createInMemoryDocumentStore({ now: world.now }),
      blobStore: createInMemoryBlobStore({ now: world.now }),
      ideaStore: ideas,
    });
    committedCapture = baseIngestion.captureIdea;

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "Запиши без дубля" }))
      .rejects.toMatchObject({
        name: "AssistantMutationOutcomeUnknownError",
        code: "mutation_outcome_unknown",
        message: mutationOutcomeUnknownUserMessage,
      });
    expect(runnerCalls).toBe(1);
    expect(captureCalls).toBe(1);
    await expect(ideas.list("owner")).resolves.toMatchObject([{ id: "idea-uncertain-1", summary: "Commit happened before disconnect" }]);
    expect(world.auditEvents.filter(({ type }) => type === "overflow_recovery")).toHaveLength(0);
    expect(world.auditEvents.filter(({ type }) => type === "idea_captured")).toHaveLength(0);
  });

  it("does not fallback after a mutating tool returns a pre-commit-looking error", async () => {
    let runnerCalls = 0;
    let captureCalls = 0;
    const { service, ideas, world } = setup(async (_input, context) => {
      runnerCalls += 1;
      await context.captureIdea({
        project: "АССИСТЕНТ",
        type: "development",
        summary: "Не повторять автоматически",
        suggestedNextStep: "Проверить список.",
        needsProjectClarification: false,
      });
      return "unreachable";
    }, snapshot(), defaultContextBudget, {
      captureIdea: async () => {
        captureCalls += 1;
        throw new Error("connection failed before response");
      },
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "Сохрани при сетевом сбое" }))
      .rejects.toMatchObject({
        name: "AssistantMutationOutcomeUnknownError",
        code: "mutation_outcome_unknown",
        message: mutationOutcomeUnknownUserMessage,
      });
    expect(runnerCalls).toBe(1);
    expect(captureCalls).toBe(1);
    await expect(ideas.list("owner")).resolves.toEqual([]);
    expect(world.auditEvents.filter(({ type }) => type === "overflow_recovery")).toHaveLength(0);
  });

  it("keeps safe overflow retry enabled after a read-only tool failure", async () => {
    let calls = 0;
    const { service, ideas, world } = setup(async (_input, context) => {
      calls += 1;
      if (calls === 1) {
        try { await context.documents.readDocument({ path: "../invalid.md" }); } catch { throw overflowError(); }
      }
      return "Восстановлено после read-only ошибки.";
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "Прочитай и продолжи" })).resolves.toMatchObject({
      response: "Восстановлено после read-only ошибки.",
      selectedProcessIds: ["core"],
    });
    expect(calls).toBe(2);
    await expect(ideas.list("owner")).resolves.toEqual([]);
    expect(world.auditEvents.filter(({ type }) => type === "overflow_recovery")).toHaveLength(1);
  });

  it("does not fallback when the retry committed a durable idea before overflowing", async () => {
    let calls = 0;
    const { service, ideas, world } = setup(async (_input, context) => {
      calls += 1;
      if (calls === 1) throw overflowError();
      await context.captureIdea({
        project: "АССИСТЕНТ",
        type: "development",
        summary: "Записано на повторной попытке",
        suggestedNextStep: "Продолжить позже.",
        needsProjectClarification: false,
      });
      throw overflowError();
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "Запиши после сокращения контекста" }))
      .rejects.toMatchObject({
        name: "AssistantContextOverflowError",
        durableEffectCommitted: true,
        message: expect.stringContaining("Идея уже сохранена"),
      });
    expect(calls).toBe(2);
    await expect(ideas.list("owner")).resolves.toMatchObject([{ id: "idea-overflow", summary: "Записано на повторной попытке" }]);
    expect(world.auditEvents.filter(({ type }) => type === "overflow_recovery")).toHaveLength(1);
    expect(world.auditEvents.filter(({ type }) => type === "idea_captured")).toHaveLength(1);
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

  it("selects only allow-listed overflow and uncertain-mutation messages for local and remote transports", () => {
    expect(contextOverflowUserMessage(new AssistantContextOverflowError("prompt_too_long"))).toBe(overflowRecoveryUserMessage);
    expect(contextOverflowUserMessage(new AssistantContextOverflowError("prompt_too_long", { durableEffectCommitted: true }))).toBe(overflowAfterDurableWriteUserMessage);
    expect(contextOverflowUserMessage(new MinutkaApiError("context_overflow", undefined, overflowRecoveryUserMessage))).toBe(overflowRecoveryUserMessage);
    expect(contextOverflowUserMessage(new MinutkaApiError("context_overflow", undefined, overflowAfterDurableWriteUserMessage))).toBe(overflowAfterDurableWriteUserMessage);
    expect(contextOverflowUserMessage(new MinutkaApiError("context_overflow", undefined, "provider secret"))).toBe(overflowRecoveryUserMessage);
    expect(contextOverflowUserMessage(new MinutkaApiError("internal_error", undefined, overflowAfterDurableWriteUserMessage))).toBeUndefined();
    expect(mutationOutcomeUserMessage(new AssistantMutationOutcomeUnknownError())).toBe(mutationOutcomeUnknownUserMessage);
    expect(mutationOutcomeUserMessage(new MinutkaApiError("mutation_outcome_unknown", undefined, "provider secret"))).toBe(mutationOutcomeUnknownUserMessage);
    expect(mutationOutcomeUserMessage(new MinutkaApiError("internal_error", undefined, mutationOutcomeUnknownUserMessage))).toBeUndefined();
    expect(mapError(new AssistantMutationOutcomeUnknownError())).toEqual({
      status: 503,
      code: "mutation_outcome_unknown",
      message: mutationOutcomeUnknownUserMessage,
    });
  });

  it("classifies nested Mastra surfaces, excludes throttling, and validates the reduced preset canonically", () => {
    expect(classifyProviderContextOverflow({
      message: "Mastra generation failed",
      cause: { error: { type: "invalid_request_error", code: "context_length_exceeded", message: "input is too long" } },
    })).toBe("context_length_exceeded");
    expect(classifyProviderContextOverflow({ status: 429, message: "maximum context length mentioned by a rate limit wrapper" })).toBeUndefined();

    const reduced = createOverflowRecoveryContextBudget(defaultContextBudget);
    expect(() => createOverflowRecoveryContextBudget(createContextBudgetConfig({
      sources: { history: minimumRecentHistoryCharacters },
      projectionLimits: { historyTurnCharacters: 1 },
    }))).not.toThrow();
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
    expect(new AssistantContextOverflowError("prompt_too_long")).toMatchObject({ code: "context_overflow", reason: "prompt_too_long", durableEffectCommitted: false });
  });
});
