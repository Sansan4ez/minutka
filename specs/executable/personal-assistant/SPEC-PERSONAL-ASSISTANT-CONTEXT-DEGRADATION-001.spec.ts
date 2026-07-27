import { describe, expect, it } from "vitest";
import {
  createAssistantContextProjectionBuilder,
  renderAssistantContextProjection,
  type ContextProjectionAudit,
} from "../../../src/application/assistant-context-projection.js";
import { createContextBudgetConfig, countUnicodeCharacters } from "../../../src/application/context-budget.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { AssistantService } from "../../../src/application/assistant-service.js";

const now = "2026-07-18T10:00:00.000Z";
const coreManifest = {
  version: 1 as const,
  rules: [{ id: "constitution", pattern: "^/proc/context/01_core\\.md$", matcher: /^\/proc\/context\/01_core\.md$/u }],
};

function budget(input: { context?: number; perFile?: number; documents?: number; index?: number } = {}) {
  const context = input.context ?? 16_000;
  const perFile = input.perFile ?? Math.min(4_000, context);
  return createContextBudgetConfig({
    sources: { context, context_index: input.index ?? 6_000 },
    projectionLimits: {
      contextDocuments: input.documents ?? 12,
      contextDocumentCharacters: perFile,
      contextIndexDepth: 4,
    },
  });
}

async function build(input: {
  documents: Array<{ path: string; content: string }>;
  config?: ReturnType<typeof budget>;
  manifest?: typeof coreManifest;
}) {
  const store = createInMemoryDocumentStore({ now: () => now }, input.documents.map((document) => ({ userId: "owner", path: `context/${document.path}`, content: document.content })));
  const audits: ContextProjectionAudit[] = [];
  const projection = await createAssistantContextProjectionBuilder({
    documentStore: store,
    now: () => now,
    contextBudget: input.config ?? budget(),
    contextPriorities: input.manifest ?? coreManifest,
  }).build({ userId: "owner", requestId: "request", audit: (event) => { audits.push(event); } });
  return { projection, audits };
}

describe("SPEC-PERSONAL-ASSISTANT-CONTEXT-DEGRADATION-001: explicit deterministic context degradation", () => {
  it("truncates an oversized fetched file on Unicode boundaries with a resumable path/size/offset marker", async () => {
    const content = "a".repeat(5_000);
    const { projection, audits } = await build({ documents: [{ path: "90_transcripts/huge.md", content }] });
    const document = projection.data.documents[0]!;

    expect(document).toMatchObject({
      path: "/proc/context/90_transcripts/huge.md",
      representation: "truncated",
      originalCharacters: 5_000,
      nextOffset: expect.any(Number),
    });
    expect(countUnicodeCharacters(document.content)).toBeLessThanOrEqual(4_000);
    expect(document.content).toContain("/proc/context/90_transcripts/huge.md");
    expect(document.content).toContain("original 5000 Unicode characters");
    expect(document.content).toContain(`offset=${document.nextOffset}`);
    expect(document.content).toContain("readDocument(path=");
    expect(document.content).not.toContain("�");
    expect(audits).toEqual([{
      sourceId: "context",
      reason: "per_file_limit",
      ceiling: 4_000,
      actualCharacters: 5_000,
      includedCharacters: countUnicodeCharacters(document.content),
      documentCount: 1,
      affectedCount: 1,
    }]);
    expect(JSON.stringify(audits)).not.toContain("aaaa");
  });

  it("preserves core documents whole and degrades lower-priority transcripts in manifest order", async () => {
    const core = "C".repeat(300);
    const { projection, audits } = await build({
      documents: [
        { path: "90_transcripts/meeting.md", content: "T".repeat(300) },
        { path: "01_core.md", content: core },
        { path: "20_work/note.md", content: "N".repeat(300) },
      ],
      config: budget({ context: 570, perFile: 570 }),
    });

    expect(projection.data.documents[0]).toMatchObject({ path: "/proc/context/01_core.md", content: core, representation: "full" });
    expect(projection.data.documents[1]).toMatchObject({ path: "/proc/context/20_work/note.md", representation: "index-reference", originalCharacters: 300 });
    expect(projection.data.documents).toHaveLength(2);
    expect(projection.data.index.text).toContain("meeting.md");
    expect(audits).toEqual([{
      sourceId: "context",
      reason: "context_ceiling",
      ceiling: 570,
      actualCharacters: 600,
      includedCharacters: countUnicodeCharacters(projection.data.documents[1]!.content),
      documentCount: 3,
      affectedCount: 2,
    }]);
    expect(renderAssistantContextProjection(projection)).toMatchSnapshot();
  });

  it("fails fast instead of truncating an oversized core document", async () => {
    await expect(build({
      documents: [
        { path: "01_core.md", content: "C".repeat(4_001) },
        { path: "90_transcripts/meeting.md", content: "T".repeat(500) },
      ],
    })).rejects.toThrow("core context document /proc/context/01_core.md has 4001 Unicode characters and exceeds the 4000-character per-file ceiling");
  });

  it("aggregates document-limit omissions without paths or document text while the index keeps every file visible", async () => {
    const { projection, audits } = await build({
      documents: Array.from({ length: 141 }, (_, index) => ({ path: `80_inbox/file-${String(index).padStart(3, "0")}.md`, content: `SECRET-${index}` })),
      config: budget({ documents: 12 }),
    });

    expect(projection.data.documents).toHaveLength(12);
    expect(projection.data.index.documentCount).toBe(141);
    expect(projection.data.index.text).toContain("file-140.md");
    expect(audits).toEqual([{
      sourceId: "context",
      reason: "document_limit",
      ceiling: 12,
      actualCharacters: 1_202,
      includedCharacters: 0,
      documentCount: 141,
      affectedCount: 129,
    }]);
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain("file-");
    expect(serialized).not.toContain("SECRET");
  });

  it("keeps degradation audit cardinality bounded for thousands of omitted documents", async () => {
    const documents = Array.from({ length: 5_000 }, (_, index) => ({ path: `folder-${index % 10}/file-${String(index).padStart(4, "0")}.md`, content: "PRIVATE" }));
    const { projection, audits } = await build({
      documents,
      config: budget({ documents: 1, index: 2_000 }),
    });

    expect(projection.data.truncated).toBe(true);
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      sourceId: "context",
      reason: "document_limit",
      documentCount: 5_000,
      affectedCount: 4_999,
    });
    expect(audits[1]).toMatchObject({
      sourceId: "context_index",
      documentCount: 5_000,
      affectedCount: 5_000,
    });
    expect(JSON.stringify(audits)).not.toContain("PRIVATE");
    expect(JSON.stringify(audits)).not.toContain("file-");
  });

  it("persists only allow-listed size/reason projection audit metadata", async () => {
    const world = createInMemoryWorld(() => now);
    const store = createInMemoryDocumentStore({ now: world.now }, [
      { userId: "owner", path: "context/90_transcripts/huge.md", content: `PRIVATE-${"x".repeat(9_000)}` },
    ]);
    const auditEventStore = createInMemoryAuditEventStore(world);
    const service = new AssistantService(async () => "ok", {
      documentStore: store,
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: createIngestionService({ documentStore: store, blobStore: createInMemoryBlobStore({ now: world.now }) }),
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      auditEventStore,
      clock: { now: world.now },
      contextPriorities: coreManifest,
    });

    await service.chat({ userId: "owner", threadId: "thread", text: "request" });

    const event = world.auditEvents.find(({ type }) => type === "context_projection_degraded");
    expect(event?.metadata).toEqual({
      sourceId: "context",
      reason: "per_file_limit",
      ceiling: 8_000,
      actualCharacters: 9_008,
      includedCharacters: expect.any(Number),
      documentCount: 1,
      affectedCount: 1,
    });
    expect(JSON.stringify(event)).not.toContain("PRIVATE");
    expect(JSON.stringify(event)).not.toContain("huge.md");
    expect(JSON.stringify(event)).not.toContain("xxxx");
  });

  it("records the index degradation ladder as size-only audit", async () => {
    const { projection, audits } = await build({
      documents: Array.from({ length: 2_000 }, (_, index) => ({ path: `folder-${index % 20}/nested-${index % 5}/very-long-${String(index).padStart(4, "0")}.md`, content: "x" })),
      config: budget({ documents: 1, index: 1_500 }),
    });

    expect(projection.data.index.level).toBe("top-level");
    expect(audits.at(-1)).toMatchObject({
      sourceId: "context_index",
      reason: "top_level_rollup",
      ceiling: 1_500,
      documentCount: 2_000,
      affectedCount: 2_000,
    });
    expect(Object.keys(audits.at(-1)!).sort()).toEqual([
      "actualCharacters", "affectedCount", "ceiling", "documentCount", "includedCharacters", "reason", "sourceId",
    ]);
  });
});
