import { describe, expect, it } from "vitest";
import { AssistantService, deriveSelectedProcessIds } from "../../../src/application/assistant-service.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";

function harness(runner: ConstructorParameters<typeof AssistantService>[0]) {
  const clock = { now: () => "2026-07-29T09:00:00.000Z" };
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
  return new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(createInMemoryWorld(clock.now)),
    ingestionService: ingestion,
    ideaStore: ideas,
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
  });
}

describe("SPEC-PERSONAL-ASSISTANT-PROCESS-DIAGNOSTICS-001: evidence-derived process diagnostics", () => {
  it("keeps core only when process names are merely mentioned", async () => {
    const service = harness(async () => ({
      text: "I can mention day_focus and inbox_capture without using either process.",
      executionTrace: [],
    }));

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "Что умеешь?" })).resolves.toMatchObject({
      selectedProcessIds: ["core"],
    });
  });

  it("derives inbox_capture from an actual capture action even when the runner trace is empty", async () => {
    const service = harness(async (_input, context) => {
      const captured = await context.captureIdea({
        project: "ASSISTANT",
        type: "development",
        summary: "Trace actual capture",
        suggestedNextStep: "Verify diagnostics.",
        needsProjectClarification: false,
      });
      return { text: captured.response, executionTrace: [] };
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "Сохрани идею" })).resolves.toMatchObject({
      selectedProcessIds: ["core", "inbox_capture"],
    });
  });

  it("preserves the runner trace order, deduplicates evidence, and ignores unknown ids", () => {
    expect(deriveSelectedProcessIds(
      [
        { kind: "tool", toolName: "listTasks" },
        { kind: "process", processId: "knowledge_lookup" },
        { kind: "process", processId: "day_focus" },
        { kind: "tool", toolName: "captureIdea" },
        { kind: "tool", toolName: "captureIdea" },
        { kind: "process", processId: "day_focus" },
        { kind: "process", processId: "evening_reflection" },
        { kind: "process", processId: "unknown" },
      ],
    )).toEqual(["core", "day_focus", "knowledge_lookup", "inbox_capture", "evening_reflection"]);
  });

  it("rejects unknown inline process ids and grants no business capability", async () => {
    const service = harness(async (_input, context) => {
      expect(() => context.markProcessUsed("unknown" as never)).toThrow("unknown assistant diagnostic process id");
      expect(() => context.markProcessUsed("day_focus" as never)).toThrow("unknown assistant diagnostic process id");
      context.markProcessUsed("evening_reflection");
      return { text: "Read-only focus and reflection answer.", executionTrace: [] };
    });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "Что делать сейчас?" });
    expect(result.selectedProcessIds).toEqual(["core", "evening_reflection"]);
    expect(result.effect).toBe("none");
    expect(result.pendingActions[0]).toBeUndefined();
  });
});
