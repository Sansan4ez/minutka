import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createContextBudgetConfig } from "../../../src/application/context-budget.js";
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
import type { ThreadSummarizer } from "../../../src/application/thread-summarizer.js";

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

async function appendTurns(count: number, conversations: ReturnType<typeof createInMemoryConversationStore>) {
  for (let index = 1; index <= count; index++) {
    await conversations.appendTurn({
      messageId: `msg-${index}`,
      employeeId: "owner",
      threadId: "thread",
      userText: `turn-${index}`,
      agentResponse: `reply-${index}`,
      timestamp: `2026-07-26T00:00:${String(index).padStart(2, "0")}.000Z`,
    });
  }
}

describe("SPEC-PERSONAL-ASSISTANT-THREAD-SUMMARY-001: two-layer thread history", () => {
  it("summarizes exactly the turn falling outside the recent window and advances the watermark incrementally", async () => {
    const world = createInMemoryWorld(() => "2026-07-26T01:00:00.000Z");
    const conversations = createInMemoryConversationStore(world);
    const summaries = createInMemoryThreadSummaryStore(world);
    await appendTurns(11, conversations);
    const calls: Array<{ previous?: string; ids: string[] }> = [];
    const summarizer: ThreadSummarizer = async ({ previous, turns }) => {
      calls.push({ previous: previous?.text, ids: turns.map((turn) => turn.messageId) });
      return { text: structured([previous?.text, ...turns.map((turn) => turn.userText)].filter(Boolean).join(" | ")) };
    };
    const compaction = createThreadCompactionService({
      conversationStore: conversations, summaryStore: summaries, summarizer,
      recentTurnLimit: 10, summaryCeiling: 4_000, clock: { now: world.now }, idGenerator: createDeterministicIdGenerator(),
    });

    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req-1" });
    expect(calls[0]?.ids).toEqual(["msg-1"]);
    expect((await summaries.get({ employeeId: "owner", threadId: "thread" }))?.watermark).toEqual({ fromMessageId: "msg-1", throughMessageId: "msg-1" });

    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req-2" });
    expect(calls).toHaveLength(1);

    await conversations.appendTurn({ messageId: "msg-12", employeeId: "owner", threadId: "thread", userText: "turn-12", agentResponse: "reply-12", timestamp: "2026-07-26T00:00:12.000Z" });
    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req-3" });
    expect(calls[1]?.ids).toEqual(["msg-2"]);
    expect(calls[1]?.previous).toContain("turn-1");
    expect((await summaries.get({ employeeId: "owner", threadId: "thread" }))?.watermark).toEqual({ fromMessageId: "msg-1", throughMessageId: "msg-2" });
    expect(world.messages).toHaveLength(12);
  });

  it("extracts insights before summarization and lets either step fail independently", async () => {
    const world = createInMemoryWorld(() => "2026-07-26T01:00:00.000Z");
    const conversations = createInMemoryConversationStore(world);
    const summaries = createInMemoryThreadSummaryStore(world);
    const insights = createInMemoryInsightStore(world);
    const audit = createInMemoryAuditEventStore(world);
    await appendTurns(11, conversations);
    const order: string[] = [];
    const compaction = createThreadCompactionService({
      conversationStore: conversations, summaryStore: summaries,
      insightExtractor: async () => { order.push("insights"); throw new Error("extractor unavailable"); },
      insightStore: insights,
      summarizer: async ({ turns }) => { order.push("summary"); return { text: structured(turns[0]!.userText) }; },
      auditEventStore: audit, recentTurnLimit: 10, summaryCeiling: 4_000,
      clock: { now: world.now }, idGenerator: createDeterministicIdGenerator(),
    });

    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req" });

    expect(order).toEqual(["insights", "summary"]);
    expect(await summaries.get({ employeeId: "owner", threadId: "thread" })).toBeDefined();
    expect(world.auditEvents.find((event) => event.type === "thread_compaction_insight_failed")?.metadata).toEqual({ reason: "Error", turnCount: 1 });
  });

  it("re-summarizes on overflow, records explicit reduction, and never silently clips", async () => {
    const world = createInMemoryWorld(() => "2026-07-26T01:00:00.000Z");
    const conversations = createInMemoryConversationStore(world);
    const summaries = createInMemoryThreadSummaryStore(world);
    const audit = createInMemoryAuditEventStore(world);
    await appendTurns(11, conversations);
    const passes: boolean[] = [];
    const compaction = createThreadCompactionService({
      conversationStore: conversations, summaryStore: summaries,
      summarizer: async ({ reduce }) => {
        passes.push(reduce);
        return { text: reduce ? structured("- История сокращена для лимита.") : structured("x".repeat(500)) };
      },
      auditEventStore: audit, recentTurnLimit: 10, summaryCeiling: 140,
      clock: { now: world.now }, idGenerator: createDeterministicIdGenerator(),
    });

    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req" });

    const summary = await summaries.get({ employeeId: "owner", threadId: "thread" });
    expect(passes).toEqual([false, true]);
    expect(summary?.text).toContain("История сокращена для лимита");
    expect([...(summary?.text ?? "")].length).toBeLessThanOrEqual(140);
    expect(world.auditEvents.find((event) => event.type === "thread_summary_updated")?.metadata.reduced).toBe(true);
  });

  it("keeps the previous valid checkpoint and all turns when summarization fails", async () => {
    const world = createInMemoryWorld(() => "2026-07-26T01:00:00.000Z");
    const conversations = createInMemoryConversationStore(world);
    const summaries = createInMemoryThreadSummaryStore(world);
    const audit = createInMemoryAuditEventStore(world);
    await appendTurns(11, conversations);
    await summaries.save({ employeeId: "owner", threadId: "thread", text: structured("old"), watermark: { fromMessageId: "msg-1", throughMessageId: "msg-1" }, updatedAt: world.now() });
    await conversations.appendTurn({ messageId: "msg-12", employeeId: "owner", threadId: "thread", userText: "turn-12", agentResponse: "reply-12", timestamp: "2026-07-26T00:00:12.000Z" });
    const compaction = createThreadCompactionService({
      conversationStore: conversations, summaryStore: summaries,
      summarizer: async () => { throw new Error("network body must not enter audit"); },
      auditEventStore: audit, recentTurnLimit: 10, summaryCeiling: 4_000,
      clock: { now: world.now }, idGenerator: createDeterministicIdGenerator(),
    });

    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req" });

    expect((await summaries.get({ employeeId: "owner", threadId: "thread" }))?.text).toBe(structured("old"));
    expect(world.messages).toHaveLength(12);
    expect(JSON.stringify(world.auditEvents)).not.toContain("network body");
    expect(world.auditEvents.find((event) => event.type === "thread_summary_failed")?.metadata.reason).toBe("Error");
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

  it("keeps thread-summary configuration aligned with its budgeted source", () => {
    expect(createContextBudgetConfig({
      sources: { thread_summary: 2_000 },
      projectionLimits: { threadSummaryCharacters: 2_000 },
    }).projectionLimits.threadSummaryCharacters).toBe(2_000);
    expect(() => createContextBudgetConfig({ sources: { thread_summary: 2_000 } })).toThrow("must not exceed");
  });
});
