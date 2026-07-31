import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryUsageStore } from "../../../src/application/in-memory-usage-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import type { UsageCostPolicy } from "../../../src/application/usage-store.js";

const policy: UsageCostPolicy = {
  monthlySoftLimitUsdMicros: 500,
  inputUsdMicrosPerMillionTokens: 1_000_000,
  outputUsdMicrosPerMillionTokens: 1_000_000,
};

describe("SPEC-PERSONAL-ASSISTANT-USAGE-001: owner monthly usage and soft limit", () => {
  it("aggregates metadata-only usage by owner and UTC month, warns without blocking", async () => {
    let now = "2026-07-31T23:59:00.000Z";
    const world = createInMemoryWorld(() => now);
    const documents = createInMemoryDocumentStore({ now: world.now });
    const usageStore = createInMemoryUsageStore();
    const operationalWarnings: unknown[] = [];
    const service = new AssistantService(async () => ({
      text: "Готово.",
      executionTrace: [],
      usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
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
      userId: "owner-a", month: "2026-07", inputTokens: 400, outputTokens: 200, totalTokens: 600, estimatedCostUsdMicros: 600,
    });
    expect(await usageStore.getMonthly("owner-b", "2026-07")).toMatchObject({ totalTokens: 300, estimatedCostUsdMicros: 300 });
    expect(operationalWarnings).toEqual([{
      type: "usage_soft_limit_exceeded", userId: "owner-a", month: "2026-07", estimatedCostUsdMicros: 600, softLimitUsdMicros: 500,
    }]);
    expect(world.auditEvents.filter((event) => event.type === "usage_soft_limit_exceeded")).toEqual([
      expect.objectContaining({
        employeeId: "owner-a",
        metadata: { month: "2026-07", inputTokens: 400, outputTokens: 200, totalTokens: 600, estimatedCostUsdMicros: 600, softLimitUsdMicros: 500 },
      }),
    ]);

    const serializedUsage = JSON.stringify(await usageStore.listRecords());
    expect(serializedUsage).not.toContain("Первый запрос");
    expect(serializedUsage).not.toContain("Второй приватный запрос");
    expect(serializedUsage).not.toContain("Готово");

    now = "2026-08-01T00:01:00.000Z";
    const august = await service.chat({ userId: "owner-a", threadId: "thread-a", text: "Новый месяц" });
    expect(august.response).toBe("Готово.");
    expect(await usageStore.getMonthly("owner-a", "2026-08")).toMatchObject({ totalTokens: 300, estimatedCostUsdMicros: 300 });
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
