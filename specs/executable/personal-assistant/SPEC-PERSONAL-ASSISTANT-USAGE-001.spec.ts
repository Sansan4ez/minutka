import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryThreadSummaryStore } from "../../../src/application/in-memory-thread-summary-store.js";
import { createInMemoryUsageStore } from "../../../src/application/in-memory-usage-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { createThreadCompactionService } from "../../../src/application/thread-compaction-service.js";
import { createUsageRecorder } from "../../../src/application/usage-recorder.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { estimateUsageCostUsdMicros, type UsageCostPolicy } from "../../../src/application/usage-store.js";

const policy: UsageCostPolicy = {
  monthlySoftLimitUsdMicros: 300,
  inputUsdMicrosPerMillionTokens: 1_000_000,
  cachedInputUsdMicrosPerMillionTokens: 100_000,
  outputUsdMicrosPerMillionTokens: 1_000_000,
};

/** (200 - 120) * $1/M + 120 * $0.1/M + 100 * $1/M = 192 USD micros. */
const chatTurnCostUsdMicros = 192;

const chatUsage = { inputTokens: 200, outputTokens: 100, totalTokens: 300, llmSteps: 2, cachedInputTokens: 120 };

const structuredSummary = [
  "## Факты",
  "- факт",
  "## Решения",
  "- нет",
  "## Договорённости",
  "- нет",
  "## Открытые вопросы",
  "- нет",
].join("\n");

describe("SPEC-PERSONAL-ASSISTANT-USAGE-001: owner monthly usage, cost and soft limit", () => {
  it("prices cached input separately and never invents a cache hit the provider did not report", () => {
    const providerRates: UsageCostPolicy = {
      monthlySoftLimitUsdMicros: 20_000_000,
      inputUsdMicrosPerMillionTokens: 5_000_000,
      cachedInputUsdMicrosPerMillionTokens: 500_000,
      outputUsdMicrosPerMillionTokens: 30_000_000,
    };
    const observed = { inputTokens: 17_710, outputTokens: 163, totalTokens: 17_873 };

    expect(estimateUsageCostUsdMicros({ ...observed, cachedInputTokens: 1_536 }, providerRates)).toBe(86_528);
    // No reported breakdown: the whole input stays at the full rate.
    expect(estimateUsageCostUsdMicros(observed, providerRates)).toBe(93_440);
    // A reported cache miss is a fact, not a missing field, and prices the same.
    expect(estimateUsageCostUsdMicros({ ...observed, cachedInputTokens: 0 }, providerRates)).toBe(93_440);
    // The store boundary still rejects an impossible breakdown.
    expect(() => estimateUsageCostUsdMicros({ ...observed, cachedInputTokens: 17_711 }, providerRates))
      .toThrow("cached input tokens must not exceed input tokens");
  });

  it("keeps the first usage row when the same owner request and source are replayed", async () => {
    const usageStore = createInMemoryUsageStore();
    const first = {
      id: "usage-first", userId: "owner", requestId: "request-replayed", source: "chat" as const, month: "2026-07",
      inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40,
      estimatedCostUsdMicros: 80, occurredAt: "2026-07-15T10:00:00.000Z",
    };

    expect(await usageStore.record(first)).toMatchObject({ inserted: true });
    expect(await usageStore.record({
      ...first,
      id: "usage-conflicting-replay",
      inputTokens: 900,
      outputTokens: 100,
      totalTokens: 1_000,
      cachedInputTokens: 0,
      estimatedCostUsdMicros: 700,
      occurredAt: "2026-07-15T10:01:00.000Z",
    })).toMatchObject({
      inserted: false,
      monthly: { records: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120, estimatedCostUsdMicros: 80 },
    });
    expect(await usageStore.listRecords()).toEqual([first]);
  });

  it("aggregates metadata-only usage by owner and UTC month, warns without blocking", async () => {
    let now = "2026-07-31T23:59:00.000Z";
    const world = createInMemoryWorld(() => now);
    const documents = createInMemoryDocumentStore({ now: world.now });
    const usageStore = createInMemoryUsageStore();
    const operationalWarnings: unknown[] = [];
    const service = new AssistantService(async () => ({
      text: "Готово.",
      executionTrace: [],
      usage: chatUsage,
    }), {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) }),
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      auditEventStore: createInMemoryAuditEventStore(world),
      usageStore,
      usageCostPolicy: policy,
      operationalLogger: (warning) => operationalWarnings.push(warning),
      clock: { now: world.now },
      idGenerator: createDeterministicIdGenerator(),
    });

    const first = await service.chat({ userId: "owner-a", threadId: "thread-a", text: "Первый запрос с приватным содержимым" });
    const second = await service.chat({ userId: "owner-a", threadId: "thread-a", text: "Второй приватный запрос" });
    await service.chat({ userId: "owner-b", threadId: "thread-b", text: "Запрос другого владельца" });

    expect(first.response).toBe("Готово.");
    expect(second.response).toContain("Готово.");
    expect(second.response).toContain("Мягкий месячный лимит использования превышен");
    expect(await usageStore.getMonthly("owner-a", "2026-07")).toEqual({
      userId: "owner-a", month: "2026-07", inputTokens: 400, outputTokens: 200, totalTokens: 600,
      estimatedCostUsdMicros: 2 * chatTurnCostUsdMicros, records: 2, cachedInputTokens: 240, cachedInputUnknownRecords: 0,
      bySource: [{
        source: "chat", inputTokens: 400, outputTokens: 200, totalTokens: 600,
        estimatedCostUsdMicros: 2 * chatTurnCostUsdMicros, records: 2, cachedInputTokens: 240, cachedInputUnknownRecords: 0,
      }],
    });
    expect(await usageStore.getMonthly("owner-b", "2026-07")).toMatchObject({ totalTokens: 300, estimatedCostUsdMicros: chatTurnCostUsdMicros });
    const turnUsage = { type: "assistant_turn_usage", source: "chat", requestId: expect.any(String), ...chatUsage };
    const contextSourceCharacters = expect.objectContaining({
      base_instructions: expect.any(Number), agent_manual: expect.any(Number), context: expect.any(Number), context_index: expect.any(Number),
    });
    expect(operationalWarnings).toEqual([
      { ...turnUsage, userId: "owner-a", contextSourceCharacters },
      { ...turnUsage, userId: "owner-a", contextSourceCharacters },
      { type: "usage_soft_limit_exceeded", userId: "owner-a", month: "2026-07", estimatedCostUsdMicros: 384, softLimitUsdMicros: 300 },
      { ...turnUsage, userId: "owner-b", contextSourceCharacters },
    ]);
    expect(world.auditEvents.filter((event) => event.type === "usage_soft_limit_exceeded")).toEqual([
      expect.objectContaining({
        employeeId: "owner-a",
        metadata: {
          month: "2026-07", source: "chat", inputTokens: 400, outputTokens: 200, totalTokens: 600,
          cachedInputTokens: 240, cachedInputUnknownRecords: 0, estimatedCostUsdMicros: 384, softLimitUsdMicros: 300,
        },
      }),
    ]);

    expect(await usageStore.listRecords()).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "chat", llmSteps: 2, cachedInputTokens: 120 }),
    ]));
    const serializedOperationalWarnings = JSON.stringify(operationalWarnings);
    expect(serializedOperationalWarnings).not.toContain("Первый запрос");
    expect(serializedOperationalWarnings).not.toContain("Второй приватный запрос");
    expect(serializedOperationalWarnings).not.toContain("Запрос другого владельца");
    expect(serializedOperationalWarnings).not.toContain("Готово");

    const serializedUsage = JSON.stringify(await usageStore.listRecords());
    expect(serializedUsage).not.toContain("Первый запрос");
    expect(serializedUsage).not.toContain("Второй приватный запрос");
    expect(serializedUsage).not.toContain("Готово");

    now = "2026-08-01T00:01:00.000Z";
    const august = await service.chat({ userId: "owner-a", threadId: "thread-a", text: "Новый месяц" });
    expect(august.response).toBe("Готово.");
    expect(await usageStore.getMonthly("owner-a", "2026-08")).toMatchObject({ totalTokens: 300, estimatedCostUsdMicros: chatTurnCostUsdMicros });
  });

  it("counts the guard call of the same turn under its own source instead of dropping it", async () => {
    const world = createInMemoryWorld(() => "2026-07-15T10:00:00.000Z");
    const documents = createInMemoryDocumentStore({ now: world.now });
    const usageStore = createInMemoryUsageStore();
    const guardUsage = { inputTokens: 50, outputTokens: 10, totalTokens: 60, llmSteps: 1 };
    const service = new AssistantService(async () => ({ text: "Готово.", executionTrace: [], usage: chatUsage }), {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) }),
      requestIntegrityGuard: async () => ({ status: "allowed", usage: guardUsage }),
      auditEventStore: createInMemoryAuditEventStore(world),
      usageStore,
      usageCostPolicy: { ...policy, monthlySoftLimitUsdMicros: 100 },
      clock: { now: world.now },
      idGenerator: createDeterministicIdGenerator(),
    });

    const first = await service.chat({ userId: "owner", threadId: "thread", text: "Первый ход" });
    const second = await service.chat({ userId: "owner", threadId: "thread", text: "Второй ход" });

    const records = await usageStore.listRecords();
    // Both calls of the first turn survive: the deduplication key carries the source.
    const firstTurn = records.filter((record) => record.requestId === records[0]!.requestId);
    expect(firstTurn.map((record) => record.source).sort()).toEqual(["chat", "guard"]);
    expect(new Set(firstTurn.map((record) => record.requestId)).size).toBe(1);
    expect(await usageStore.getMonthly("owner", "2026-07")).toMatchObject({
      records: 4,
      estimatedCostUsdMicros: 2 * (chatTurnCostUsdMicros + 60),
      // The guard reported no cache breakdown; that stays unknown, not a zero hit.
      cachedInputTokens: 240,
      cachedInputUnknownRecords: 2,
      bySource: [
        expect.objectContaining({ source: "chat", records: 2, estimatedCostUsdMicros: 2 * chatTurnCostUsdMicros }),
        expect.objectContaining({ source: "guard", records: 2, estimatedCostUsdMicros: 120 }),
      ],
    });
    // The owner keeps seeing the warning every turn while the month is over the
    // limit, but the operator is alerted once, on the row that crossed it.
    expect(first.response).toContain("Мягкий месячный лимит использования превышен");
    expect(second.response).toContain("Мягкий месячный лимит использования превышен");
    expect(world.auditEvents.filter((event) => event.type === "usage_soft_limit_exceeded")).toHaveLength(1);
  });

  it("counts thread compaction of the same request under the summarization source", async () => {
    const world = createInMemoryWorld(() => "2026-07-15T10:00:00.000Z");
    const usageStore = createInMemoryUsageStore();
    const conversationStore = createInMemoryConversationStore(world);
    const usageRecorder = createUsageRecorder({
      usageStore,
      usageCostPolicy: policy,
      clock: { now: world.now },
      idGenerator: createDeterministicIdGenerator(),
      operationalLogger: () => {},
    });
    for (let index = 1; index <= 12; index++) {
      await conversationStore.appendTurn({
        messageId: `msg-${index}`, employeeId: "owner", threadId: "thread",
        userText: `turn-${index}`, agentResponse: `reply-${index}`,
        timestamp: new Date(Date.UTC(2026, 6, 15, 9, 0, index)).toISOString(),
      });
    }
    const compaction = createThreadCompactionService({
      conversationStore,
      summaryStore: createInMemoryThreadSummaryStore(world),
      summarizer: async () => ({ text: structuredSummary, usage: { inputTokens: 900, outputTokens: 60, totalTokens: 960, llmSteps: 1, cachedInputTokens: 800 } }),
      recentTurnLimit: 4,
      batchTurnLimit: 8,
      fieldCharacterLimit: 400,
      summaryCeiling: 4_000,
      clock: { now: world.now },
      idGenerator: createDeterministicIdGenerator(),
      usageRecorder,
    });

    // Compaction reuses the request id of the chat turn that scheduled it, so
    // without the source in the key it would collide with the chat row.
    await usageRecorder.record({ userId: "owner", requestId: "req-shared", source: "chat", usage: chatUsage });
    await compaction.compact({ employeeId: "owner", threadId: "thread", requestId: "req-shared" });

    const records = await usageStore.listRecords();
    expect(records.map((record) => record.source).sort()).toEqual(["chat", "summarization"]);
    expect(records.every((record) => record.requestId === "req-shared")).toBe(true);
    expect(await usageStore.getMonthly("owner", "2026-07")).toMatchObject({
      records: 2,
      // (900 - 800) * $1/M + 800 * $0.1/M + 60 * $1/M = 240
      estimatedCostUsdMicros: chatTurnCostUsdMicros + 240,
      bySource: [
        expect.objectContaining({ source: "chat", records: 1 }),
        expect.objectContaining({ source: "summarization", records: 1, cachedInputTokens: 800 }),
      ],
    });
  });

  it("counts onboarding profile extraction under the onboarding source", async () => {
    const world = createInMemoryWorld(() => "2026-07-15T10:00:00.000Z");
    const usageStore = createInMemoryUsageStore();
    const runtime = createInMemoryRuntime({
      world,
      agentRunner: async () => "Добро пожаловать!",
      deps: {
        onboardingProfileExtractor: async () => ({
          preferredName: "Алексей",
          ambiguousFields: [],
          usage: { inputTokens: 300, outputTokens: 20, totalTokens: 320, llmSteps: 1 },
        }),
        usageRecorder: createUsageRecorder({
          usageStore,
          usageCostPolicy: policy,
          clock: { now: world.now },
          idGenerator: createDeterministicIdGenerator(),
          operationalLogger: () => {},
        }),
      },
    });
    await runtime.service.issueInvite({ employeeId: "owner", inviteCode: "invite_owner" });
    await runtime.service.openInvite({ inviteCode: "invite_owner" });
    await runtime.service.acceptConsent({ employeeId: "owner", accepted: true, source: "test" });

    await runtime.service.submitOnboardingAnswer({ employeeId: "owner", text: "Зови меня Алексей" });

    const records = await usageStore.listRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ userId: "owner", source: "onboarding", inputTokens: 300, outputTokens: 20 });
    // The patch reaches the draft; usage never leaks into onboarding data.
    expect(world.onboardingDrafts[0]).toMatchObject({ preferredName: "Алексей" });
    expect(JSON.stringify(world.onboardingDrafts)).not.toContain("usage");
  });

  it("persists usage and evaluates the soft limit when cached tokens were sanitized by the producer", async () => {
    const world = createInMemoryWorld(() => "2026-07-31T12:00:00.000Z");
    const documents = createInMemoryDocumentStore({ now: world.now });
    const usageStore = createInMemoryUsageStore();
    const service = new AssistantService(async () => ({
      text: "Учёт сохранён.", executionTrace: [], usage: { inputTokens: 400, outputTokens: 200, totalTokens: 600, llmSteps: 2 },
    }), {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) }),
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      auditEventStore: createInMemoryAuditEventStore(world),
      usageStore,
      usageCostPolicy: policy,
      clock: { now: world.now },
      idGenerator: createDeterministicIdGenerator(),
    });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "Посчитай usage" });

    expect(result.response).toContain("Учёт сохранён.");
    expect(result.response).toContain("Мягкий месячный лимит использования превышен");
    expect(await usageStore.getMonthly("owner", "2026-07")).toEqual({
      userId: "owner", month: "2026-07", inputTokens: 400, outputTokens: 200, totalTokens: 600,
      estimatedCostUsdMicros: 600, records: 1, cachedInputTokens: 0, cachedInputUnknownRecords: 1,
      bySource: [{
        source: "chat", inputTokens: 400, outputTokens: 200, totalTokens: 600,
        estimatedCostUsdMicros: 600, records: 1, cachedInputTokens: 0, cachedInputUnknownRecords: 1,
      }],
    });
    expect(await usageStore.listRecords()).toEqual([
      expect.objectContaining({ inputTokens: 400, outputTokens: 200, totalTokens: 600, llmSteps: 2 }),
    ]);
  });

  it("does not discard a successful answer when usage persistence fails", async () => {
    const world = createInMemoryWorld(() => "2026-07-31T12:00:00.000Z");
    const documents = createInMemoryDocumentStore({ now: world.now });
    const service = new AssistantService(async () => ({
      text: "Ответ сохранён.", executionTrace: [], usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }), {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) }),
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      usageStore: { async record() { throw new Error("usage unavailable"); }, async getMonthly() { throw new Error("usage unavailable"); } },
      usageCostPolicy: policy,
      clock: { now: world.now },
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "Продолжай" })).resolves.toMatchObject({ response: "Ответ сохранён." });
    expect(world.messages).toHaveLength(1);
  });
});
