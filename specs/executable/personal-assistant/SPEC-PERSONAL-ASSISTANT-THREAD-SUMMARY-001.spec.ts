import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { countUnicodeCharacters, createContextBudgetConfig } from "../../../src/application/context-budget.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryFeedbackStore } from "../../../src/application/in-memory-feedback-store.js";
import { createInMemoryInsightStore } from "../../../src/application/in-memory-insight-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryThreadSummaryStore } from "../../../src/application/in-memory-thread-summary-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createRuntimeProjectionBuilder } from "../../../src/application/runtime-projections/runtime-projection-builder.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { createThreadCompactionService } from "../../../src/application/thread-compaction-service.js";
import { minimumThreadSummaryCharacters, threadSummaryReductionMarker, type ThreadSummarizer } from "../../../src/application/thread-summarizer.js";
import { summarizeThreadWithAgent } from "../../../src/mastra/thread-summarizer.js";
import { threadSummarizerAgent } from "../../../src/mastra/agents/thread-summarizer-agent.js";

const structured = (body: string) => [
  "## Факты",
  body,
  "## Решения",
  "- нет",
  "## Договорённости",
  "- нет",
  "## Открытые вопросы",
  "- нет",
].join("\n");

const structuredSections = (body: string) => [
  "## Факты",
  `факт-${body}`,
  "## Решения",
  `решение-${body}`,
  "## Договорённости",
  `договорённость-${body}`,
  "## Открытые вопросы",
  `вопрос-${body}`,
].join("\n");

async function appendTurns(
  count: number,
  conversations: ReturnType<typeof createInMemoryConversationStore>,
  options: { userText?: (index: number) => string; agentResponse?: (index: number) => string } = {},
) {
  for (let index = 1; index <= count; index++) {
    await conversations.appendTurn({
      messageId: `msg-${index}`,
      employeeId: "owner",
      threadId: "thread",
      userText: options.userText?.(index) ?? `turn-${index}`,
      agentResponse: options.agentResponse?.(index) ?? `reply-${index}`,
      timestamp: new Date(Date.UTC(2026, 6, 26, 0, 0, index)).toISOString(),
    });
  }
}

function createCompaction(
  world: ReturnType<typeof createInMemoryWorld>,
  conversations: ReturnType<typeof createInMemoryConversationStore>,
  summaries: ReturnType<typeof createInMemoryThreadSummaryStore>,
  summarizer: ThreadSummarizer,
  overrides: Partial<{
    recentTurnLimit: number;
    batchTurnLimit: number;
    fieldCharacterLimit: number;
    summaryCeiling: number;
  }> = {},
) {
  return createThreadCompactionService({
    conversationStore: conversations,
    summaryStore: summaries,
    summarizer,
    recentTurnLimit: overrides.recentTurnLimit ?? 10,
    batchTurnLimit: overrides.batchTurnLimit ?? 10,
    fieldCharacterLimit: overrides.fieldCharacterLimit ?? 2_000,
    summaryCeiling: overrides.summaryCeiling ?? 4_000,
    clock: { now: world.now },
    idGenerator: createDeterministicIdGenerator(),
  });
}

describe("SPEC-PERSONAL-ASSISTANT-THREAD-SUMMARY-001: two-layer thread history", () => {
  it("summarizes the oldest pending bounded batch and advances the watermark incrementally", async () => {
    const world = createInMemoryWorld(() => "2026-07-26T01:00:00.000Z");
    const conversations = createInMemoryConversationStore(world);
    const summaries = createInMemoryThreadSummaryStore(world);
    await appendTurns(18, conversations);
    const calls: Array<{ previous?: string; ids: string[] }> = [];
    const summarizer: ThreadSummarizer = async ({ previous, turns }) => {
      calls.push({ previous: previous?.text, ids: turns.map((turn) => turn.messageId) });
      return { text: structured([previous?.text, ...turns.map((turn) => turn.userText)].filter(Boolean).join(" | ")) };
    };
    const compaction = createCompaction(world, conversations, summaries, summarizer, { batchTurnLimit: 3 });

    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req-1" });
    expect(calls[0]?.ids).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect((await summaries.get({ employeeId: "owner", threadId: "thread" }))?.watermark).toEqual({ fromMessageId: "msg-1", throughMessageId: "msg-3" });

    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req-2" });
    expect(calls[1]?.ids).toEqual(["msg-4", "msg-5", "msg-6"]);
    expect(calls[1]?.previous).toContain("turn-1");
    expect((await summaries.get({ employeeId: "owner", threadId: "thread" }))?.watermark).toEqual({ fromMessageId: "msg-1", throughMessageId: "msg-6" });
    expect(world.messages).toHaveLength(18);
  });

  it("does not expose insight extraction or insight writes for expired turns", async () => {
    const world = createInMemoryWorld(() => "2026-07-26T01:00:00.000Z");
    const conversations = createInMemoryConversationStore(world);
    const summaries = createInMemoryThreadSummaryStore(world);
    await appendTurns(13, conversations, {
      userText: (index) => index === 1 ? "personal/private" : index === 2 ? "out-of-scope" : "integrity-denied",
    });
    const calls: string[][] = [];
    const compaction = createCompaction(world, conversations, summaries, async ({ turns }) => {
      calls.push(turns.map((turn) => turn.userText));
      return { text: structured("bounded checkpoint") };
    });

    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req" });

    expect(calls).toEqual([["personal/private", "out-of-scope", "integrity-denied"]]);
    expect(world.insights).toEqual([]);
    expect(world.auditEvents.map((event) => event.type)).not.toContain("insight_recorded");
  });

  it("handles a 1000+ turn backlog with one summarizer call and bounded turn/field input", async () => {
    const world = createInMemoryWorld(() => "2026-07-26T01:00:00.000Z");
    const conversations = createInMemoryConversationStore(world);
    const summaries = createInMemoryThreadSummaryStore(world);
    await appendTurns(1_021, conversations, {
      userText: (index) => `user-${index}-${"u".repeat(200)}`,
      agentResponse: (index) => `agent-${index}-${"a".repeat(200)}`,
    });
    const generatedPrompts: string[] = [];
    const generateOptions: unknown[] = [];
    const originalGenerate = threadSummarizerAgent.generate.bind(threadSummarizerAgent);
    threadSummarizerAgent.generate = (async (prompt: string, options: unknown) => {
      generatedPrompts.push(prompt);
      generateOptions.push(options);
      return { text: structured("bounded checkpoint") } as Awaited<ReturnType<typeof originalGenerate>>;
    }) as typeof threadSummarizerAgent.generate;
    try {
      const compaction = createCompaction(world, conversations, summaries, summarizeThreadWithAgent, {
        batchTurnLimit: 7,
        fieldCharacterLimit: 12,
      });
      await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req" });
    } finally {
      threadSummarizerAgent.generate = originalGenerate;
    }

    expect(generatedPrompts).toHaveLength(1);
    expect(generatedPrompts[0]?.match(/<untrusted-turn /g)).toHaveLength(7);
    expect(generatedPrompts[0]).toContain("<employee>user-1-uuuuu</employee>");
    expect(generatedPrompts[0]).not.toContain("user-8-");
    expect(generatedPrompts[0]).not.toContain("u".repeat(20));
    expect(generateOptions).toEqual([{ toolChoice: "none", modelSettings: { maxOutputTokens: 2_000 } }]);
    expect((await summaries.get({ employeeId: "owner", threadId: "thread" }))?.watermark.throughMessageId).toBe("msg-7");
  });

  it("keeps the previous checkpoint and raw turns when summarization or summary save fails", async () => {
    const world = createInMemoryWorld(() => "2026-07-26T01:00:00.000Z");
    const conversations = createInMemoryConversationStore(world);
    const summaries = createInMemoryThreadSummaryStore(world);
    const audit = createInMemoryAuditEventStore(world);
    await appendTurns(12, conversations);
    await summaries.save({ employeeId: "owner", threadId: "thread", text: structured("old"), watermark: { fromMessageId: "msg-1", throughMessageId: "msg-1" }, updatedAt: world.now() });
    const failingSummary = createThreadCompactionService({
      conversationStore: conversations,
      summaryStore: summaries,
      summarizer: async () => { throw new Error("network body must not enter audit"); },
      auditEventStore: audit,
      recentTurnLimit: 10,
      batchTurnLimit: 10,
      fieldCharacterLimit: 2_000,
      summaryCeiling: 4_000,
      clock: { now: world.now },
      idGenerator: createDeterministicIdGenerator(),
    });

    await failingSummary.compact({ employeeId: "owner", threadId: "thread", requestId: "req-summary" });
    expect((await summaries.get({ employeeId: "owner", threadId: "thread" }))?.watermark.throughMessageId).toBe("msg-1");

    let attemptedThrough = "";
    const failingStore = createThreadCompactionService({
      conversationStore: conversations,
      summaryStore: {
        get: summaries.get,
        save: async (summary) => { attemptedThrough = summary.watermark.throughMessageId; throw new Error("store unavailable"); },
      },
      summarizer: async () => ({ text: structured("new") }),
      auditEventStore: audit,
      recentTurnLimit: 10,
      batchTurnLimit: 10,
      fieldCharacterLimit: 2_000,
      summaryCeiling: 4_000,
      clock: { now: world.now },
      idGenerator: createDeterministicIdGenerator(),
    });
    await failingStore.compact({ employeeId: "owner", threadId: "thread", requestId: "req-store" });

    expect(attemptedThrough).toBe("msg-2");
    expect((await summaries.get({ employeeId: "owner", threadId: "thread" }))?.watermark.throughMessageId).toBe("msg-1");
    expect(world.messages).toHaveLength(12);
    expect(JSON.stringify(world.auditEvents)).not.toContain("network body");
  });

  it("reduces an oversized structured summary after one provider call and advances to the next batch", async () => {
    const world = createInMemoryWorld(() => "2026-07-26T01:00:00.000Z");
    const conversations = createInMemoryConversationStore(world);
    const summaries = createInMemoryThreadSummaryStore(world);
    await appendTurns(13, conversations);
    const callIds: string[][] = [];
    const compaction = createCompaction(world, conversations, summaries, async ({ turns }) => {
      callIds.push(turns.map((turn) => turn.messageId));
      return { text: structuredSections(`🙂${"x".repeat(500)}`) };
    }, { batchTurnLimit: 2, summaryCeiling: 140 });

    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req-1" });
    const first = await summaries.get({ employeeId: "owner", threadId: "thread" });
    expect(callIds).toEqual([["msg-1", "msg-2"]]);
    expect(first?.watermark.throughMessageId).toBe("msg-2");
    expect(countUnicodeCharacters(first?.text ?? "")).toBeLessThanOrEqual(140);
    expect(first?.text).toContain(threadSummaryReductionMarker);
    expect(first?.text).toContain("🙂");
    for (const heading of ["Факты", "Решения", "Договорённости", "Открытые вопросы"]) {
      expect(first?.text).toContain(`## ${heading}`);
    }
    for (const bodyPrefix of ["факт-", "решение-", "договор", "вопрос-"]) {
      expect(first?.text).toContain(bodyPrefix);
    }

    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req-2" });
    expect(callIds).toEqual([["msg-1", "msg-2"], ["msg-3"]]);
    expect((await summaries.get({ employeeId: "owner", threadId: "thread" }))?.watermark.throughMessageId).toBe("msg-3");
  });

  it("does not save an unstructured result or damage the previous checkpoint", async () => {
    const world = createInMemoryWorld(() => "2026-07-26T01:00:00.000Z");
    const conversations = createInMemoryConversationStore(world);
    const summaries = createInMemoryThreadSummaryStore(world);
    await appendTurns(12, conversations);
    await summaries.save({ employeeId: "owner", threadId: "thread", text: structured("old"), watermark: { fromMessageId: "msg-1", throughMessageId: "msg-1" }, updatedAt: world.now() });
    const compaction = createCompaction(world, conversations, summaries, async () => ({ text: "missing required headings" }));

    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req" });

    expect(await summaries.get({ employeeId: "owner", threadId: "thread" })).toMatchObject({
      text: structured("old"),
      watermark: { fromMessageId: "msg-1", throughMessageId: "msg-1" },
    });
  });

  it("projects the checkpoint before the ten recent verbatim turns and schedules compaction after chat", async () => {
    const world = createInMemoryWorld(() => "2026-07-26T01:00:00.000Z");
    const conversations = createInMemoryConversationStore(world);
    const summaries = createInMemoryThreadSummaryStore(world);
    const documents = createInMemoryDocumentStore({ now: world.now });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) });
    await appendTurns(11, conversations);
    await summaries.save({ employeeId: "owner", threadId: "thread", text: structured("CHECKPOINT"), watermark: { fromMessageId: "msg-1", throughMessageId: "msg-1" }, updatedAt: world.now() });
    let received = "";
    let scheduled = false;
    const projection = createRuntimeProjectionBuilder({
      profileStore: createInMemoryProfileStore(world), conversationStore: conversations, threadSummaryStore: summaries,
      insightStore: createInMemoryInsightStore(world), feedbackStore: createInMemoryFeedbackStore(world),
      auditEventStore: createInMemoryAuditEventStore(world), clock: { now: world.now },
    });
    const service = new AssistantService(async (_input, context) => { received = context.systemContext; return "ok"; }, {
      documentStore: documents, conversationStore: conversations, ingestionService: ingestion,
      chatProjectionBuilder: projection, requestIntegrityGuard: async () => ({ status: "allowed" }),
      threadCompactionService: { compact: async () => { scheduled = true; } }, clock: { now: world.now },
    });

    await service.chat({ userId: "owner", threadId: "thread", text: "continue" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received.indexOf("CHECKPOINT")).toBeLessThan(received.indexOf("turn-2"));
    expect(received).not.toContain("user: turn-1\n");
    expect(received).toContain("Watermark (inclusive): msg-1..msg-1");
    expect(scheduled).toBe(true);
  });

  it("keeps thread-summary and compaction input limits in the canonical context budget", () => {
    const config = createContextBudgetConfig({
      sources: { thread_summary: 2_000 },
      projectionLimits: {
        threadSummaryCharacters: 2_000,
        threadCompactionTurns: 4,
        threadCompactionFieldCharacters: 500,
      },
    });
    expect(config.projectionLimits).toMatchObject({
      threadSummaryCharacters: 2_000,
      threadCompactionTurns: 4,
      threadCompactionFieldCharacters: 500,
    });
    expect(() => createContextBudgetConfig({ sources: { thread_summary: 2_000 } })).toThrow("must not exceed");
    expect(() => createContextBudgetConfig({
      sources: { thread_summary: minimumThreadSummaryCharacters - 1 },
      projectionLimits: { threadSummaryCharacters: minimumThreadSummaryCharacters - 1 },
    })).toThrow(`must be at least ${minimumThreadSummaryCharacters}`);
  });
});
