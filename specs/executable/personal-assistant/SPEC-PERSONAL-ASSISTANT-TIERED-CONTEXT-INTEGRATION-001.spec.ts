import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createContextBudgetConfig } from "../../../src/application/context-budget.js";
import type { ReadDocumentResult, SearchDocumentsResult } from "../../../src/application/document-reader.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";

const now = "2026-07-18T12:00:00.000Z";

describe("SPEC-PERSONAL-ASSISTANT-TIERED-CONTEXT-INTEGRATION-001: production-shaped tiered context gate", () => {
  it("keeps every document on the map while projection and tool reads degrade explicitly within one turn", async () => {
    const world = createInMemoryWorld(() => now);
    const documentStore = createInMemoryDocumentStore({ now: world.now }, [
      { userId: "owner", path: "context/10_user_memory/01_личная_конституция.md", content: "CORE" },
      { userId: "owner", path: "context/40_projects/INDEX.md", content: "Project navigation" },
      { userId: "owner", path: "context/40_projects/plan.md", content: "needle🙂abcdefghijk" },
      { userId: "other", path: "context/private.md", content: "OTHER-OWNER-SECRET" },
    ]);
    const contextBudget = createContextBudgetConfig({
      projectionLimits: { contextDocuments: 1 },
      documentTools: {
        turnReadCharacters: 7,
        readDefaultCharacters: 5,
        readMaximumCharacters: 5,
        searchSnippetCharacters: 4,
      },
    });
    const auditEventStore = createInMemoryAuditEventStore(world);
    let systemContext = "";
    let search: SearchDocumentsResult | undefined;
    let read: ReadDocumentResult | undefined;

    const service = new AssistantService(async (_input, context) => {
      systemContext = context.systemContext;
      search = await context.documents.searchDocuments({ query: "needle", limit: 1 });
      read = await context.documents.readDocument({ path: "/proc/context/40_projects/plan.md", maxCharacters: 5 });
      return "ok";
    }, {
      documentStore,
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: createIngestionService({
        documentStore,
        blobStore: createInMemoryBlobStore({ now: world.now }),
      }),
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      auditEventStore,
      clock: { now: world.now },
      contextBudget,
      contextPriorities: {
        version: 1,
        rules: [{
          id: "personal-constitution",
          pattern: "^/proc/context/10_user_memory/01_личная_конституция\\.md$",
          matcher: /^\/proc\/context\/10_user_memory\/01_личная_конституция\.md$/u,
        }],
      },
    });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "Use the project plan" });

    expect(result.personalContextDocuments).toEqual(["/proc/context/10_user_memory/01_личная_конституция.md"]);
    expect(systemContext).toContain("Machine index: /proc/context");
    expect(systemContext).toContain("40_projects/");
    expect(systemContext).toContain("INDEX.md");
    expect(systemContext).toContain("plan.md");
    expect(systemContext).toContain("Some context documents use explicit degradation markers");
    expect(systemContext).not.toContain("private.md");
    expect(systemContext).not.toContain("OTHER-OWNER-SECRET");

    expect(search).toEqual({
      matches: [expect.objectContaining({ path: "/proc/context/40_projects/plan.md", snippet: "need…" })],
      truncated: false,
      readBudgetExhausted: false,
      hint: null,
    });
    expect(read).toMatchObject({
      path: "/proc/context/40_projects/plan.md",
      content: "ne",
      totalCharacters: 18,
      nextOffset: 2,
      truncated: true,
      readBudgetExhausted: true,
      hint: expect.stringMatching(/section or search/),
    });

    expect(world.auditEvents).toContainEqual(expect.objectContaining({
      type: "context_projection_degraded",
      metadata: expect.objectContaining({ reason: "document_limit", affectedCount: 1 }),
    }));
    expect(world.auditEvents).toContainEqual(expect.objectContaining({
      type: "document_tool_used",
      metadata: expect.objectContaining({ operation: "read", reason: "budget_exhausted", returnedCharacters: 2 }),
    }));
    const serializedAudit = JSON.stringify(world.auditEvents);
    expect(serializedAudit).not.toContain("needle🙂abcdefghijk");
    expect(serializedAudit).not.toContain("OTHER-OWNER-SECRET");
  });
});
