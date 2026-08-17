import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { loadAssistantAgentInstructions } from "../../../src/application/assistant-manual-loader.js";

const now = "2026-07-28T09:00:00.000Z";

function serviceWithRunner(runner: ConstructorParameters<typeof AssistantService>[0]) {
  const clock = { now: () => now };
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  return new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(createInMemoryWorld(clock.now)),
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas }),
    ideaStore: ideas,
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
  });
}

describe("SPEC-PERSONAL-ASSISTANT-DAY-FOCUS-001: disabled inherited day focus", () => {
  it("rejects day_focus through the product facade with an explicit reason", async () => {
    const conversation: Pick<AssistantService, "chat"> = { async chat() {
      throw new Error("disabled process must not reach chat");
    } };
    const facade = new PersonalAssistantService(
      {} as ConstructorParameters<typeof PersonalAssistantService>[0],
      conversation,
      {} as ConstructorParameters<typeof PersonalAssistantService>[2],
    );

    expect(() => facade.runScheduledProcess({
      userId: "owner",
      threadId: "telegram-thread",
      processId: "day_focus" as never,
    })).toThrow("unsupported scheduled process: day_focus");
  });

  it("rejects day_focus as a trusted required process", async () => {
    const service = serviceWithRunner(async () => ({ text: "not reached", executionTrace: [] }));

    await expect(service.chat({
      userId: "owner",
      threadId: "scheduled-thread",
      text: "Сформируй утренний фокус.",
      requiredProcessId: "day_focus" as never,
      responseChannel: "telegram",
    })).rejects.toThrow("unknown required assistant process id: day_focus");
  });

  it("rejects day_focus diagnostic evidence and records no effect", async () => {
    const service = serviceWithRunner(async (_input, context) => {
      expect(() => context.markProcessUsed("day_focus" as never)).toThrow("unknown assistant diagnostic process id: day_focus");
      return { text: "Могу помочь разобрать рабочий день.", executionTrace: [] };
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "На чём сфокусироваться?" })).resolves.toMatchObject({
      selectedProcessIds: ["core"],
      effect: "none",
      pendingActions: [],
    });
  });

  it("keeps the disabled manual out of the active prompt and catalog", () => {
    const instructions = loadAssistantAgentInstructions();
    expect(instructions).not.toContain("Process file: day_focus");
    expect(instructions).not.toContain('markProcessUsed({ id: "day_focus" })');
    expect(instructions).not.toContain("Select at most three priorities");
  });
});
