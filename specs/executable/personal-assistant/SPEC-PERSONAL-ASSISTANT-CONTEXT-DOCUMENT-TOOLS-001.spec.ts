import { describe, expect, it } from "vitest";
import { createInMemoryContextDocumentConfirmationStore } from "../../../src/application/in-memory-context-document-confirmation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { ContextDocumentService } from "../../../src/application/context-document-service.js";
import { createAssistantContextDocumentCapabilities } from "../../../src/application/assistant-context-document-capabilities.js";
import { createContextDocumentMutationTools } from "../../../src/mastra/tools/context-document-mutation-tools.js";

function harness() {
  const clock = { now: () => "2026-08-03T10:00:00.000Z" };
  const documents = createInMemoryDocumentStore(clock);
  const service = new ContextDocumentService(documents, createInMemoryContextDocumentConfirmationStore(), clock, { confirmationId: () => "context-tool-confirmation" });
  let pending: unknown;
  let reserved = false;
  const capabilities = createAssistantContextDocumentCapabilities({
    ownerId: "owner",
    service,
    reserveProposal() { if (reserved || pending) throw new Error("only one pending action"); reserved = true; },
    releaseProposal() { reserved = false; },
    onProposal(confirmation) { pending = confirmation; reserved = false; },
    onCreate() {},
  });
  return { capabilities, documents, service, tools: createContextDocumentMutationTools(capabilities), pending: () => pending };
}

describe("SPEC-PERSONAL-ASSISTANT-CONTEXT-DOCUMENT-TOOLS-001: owner-bound model schemas", () => {
  it("exposes no owner, physical key, or restore-version inputs and returns safe receipts", async () => {
    const h = harness();
    const createSchema = h.tools.createContextNote.inputSchema!["~standard"].jsonSchema.input({ target: "draft-07" });
    const updateSchema = h.tools.proposeContextDocumentUpdate.inputSchema!["~standard"].jsonSchema.input({ target: "draft-07" });
    const serializedSchemas = JSON.stringify({ createSchema, updateSchema });
    expect(serializedSchemas).not.toMatch(/ownerId|userId|bucket|physical|objectKey|restoreVersion/);

    await expect(h.tools.createContextNote.execute?.({ title: "Safe note", content: "body", destination: "00_inbox" }, {} as never)).resolves.toMatchObject({
      outcome: "created", path: "/proc/context/00_inbox/safe-note.md", version: expect.any(String),
    });
    expect(JSON.stringify(await h.tools.createContextNote.execute?.({ title: "Safe note", content: "other" }, {} as never))).not.toMatch(/owner|object|bucket/);
  });

  it("documents retrieve-before-write, related sections, and safe supplementation", () => {
    const h = harness();
    const createDescription = h.tools.createContextNote.description ?? "";
    const updateDescription = h.tools.proposeContextDocumentUpdate.description ?? "";

    expect(createDescription).toContain("retrieve-before-write");
    expect(createDescription).toContain("searchDocuments");
    expect(createDescription).toContain("supplement one clear thematic document");
    expect(createDescription).toContain("related allow-listed section");
    expect(createDescription).toContain("00_inbox only when placement is unclear");
    expect(updateDescription).toContain("supplementing a clear thematic match");
    expect(updateDescription).toContain("Preserve existing content");
  });

  it("creates a separate note in an allow-listed neighboring section and blocks arbitrary top levels", async () => {
    const h = harness();
    await h.documents.put("owner", "context/30_knowledge/pool.md", "# Бассейн\n\nТренировки");

    const created = await h.tools.createContextNote.execute?.({
      title: "Сон после бассейна",
      content: "# Сон после бассейна\n\nНаблюдение",
      destination: "30_knowledge",
    }, {} as never);

    expect(created).toMatchObject({
      outcome: "created",
      path: "/proc/context/30_knowledge/сон-после-бассейна.md",
      version: expect.any(String),
    });
    expect(JSON.stringify(created)).not.toMatch(/owner|object|bucket/);
    await expect(h.tools.createContextNote.execute?.({
      title: "Unsafe",
      content: "body",
      destination: "custom_namespace",
    } as never, {} as never)).resolves.toMatchObject({ error: true });
    await expect(h.documents.get("owner", "context/30_knowledge/сон-после-бассейна.md")).resolves.toMatchObject({
      content: "# Сон после бассейна\n\nНаблюдение",
    });
  });

  it("keeps proposal preview private and blocks trusted or arbitrary namespaces", async () => {
    const h = harness();
    const seeded = await h.documents.put("owner", "context/00_inbox/source.md", "old text");
    const modelVisible = await h.tools.proposeContextDocumentUpdate.execute?.({
      path: "/proc/context/00_inbox/source.md", expectedVersion: seeded.version, patchSearch: "old text", patchReplacement: "new text",
    }, {} as never);
    expect(modelVisible).toMatchObject({ status: "needs_confirmation", confirmation: { actionKind: "update" } });
    expect(JSON.stringify(modelVisible)).not.toMatch(/preview|new text|ownerId|payloadDigest|physical/);
    expect(h.pending()).toMatchObject({
      preview: {
        path: "/proc/context/00_inbox/source.md",
        change: {
          removed: { value: expect.stringContaining("old text") },
          added: { value: expect.stringContaining("new text") },
        },
      },
    });
    await expect(h.documents.get("owner", seeded.path)).resolves.toMatchObject({ content: "old text" });

    await expect(h.tools.proposeContextDocumentDelete.execute?.({ path: "/AGENTS.md", expectedVersion: seeded.version } as never, {} as never)).resolves.toMatchObject({ error: true, message: expect.stringContaining("/proc/context/") });
    await expect(h.tools.proposeContextDocumentMove.execute?.({
      path: "/proc/context/00_inbox/source.md", destination: "/proc/context/99_system/AGENTS.md", expectedVersion: seeded.version,
    }, {} as never)).rejects.toThrow("allow-listed context section");
  });

  it("releases the proposal slot after a patch miss so another proposal can succeed", async () => {
    const h = harness();
    const seeded = await h.documents.put("owner", "context/00_inbox/source.md", "old text");

    await expect(h.capabilities.proposeUpdate({
      path: "/proc/context/00_inbox/source.md", expectedVersion: seeded.version,
      patch: { search: "missing text", replacement: "new text" },
    })).rejects.toThrow("patch search text was not found");
    await expect(h.capabilities.proposeDelete({
      path: "/proc/context/00_inbox/source.md", expectedVersion: seeded.version,
    })).resolves.toMatchObject({ status: "needs_confirmation" });
    expect(h.pending()).toMatchObject({ actionKind: "delete" });
  });

  it("releases the proposal slot after invalid update input so another proposal can succeed", async () => {
    const h = harness();
    const seeded = await h.documents.put("owner", "context/00_inbox/source.md", "old text");

    await expect(h.capabilities.proposeUpdate({
      path: "/proc/context/00_inbox/source.md", expectedVersion: seeded.version,
      replacement: "replacement", patch: { search: "old text", replacement: "new text" },
    })).rejects.toThrow("provide exactly one replacement or patch");
    await expect(h.capabilities.proposeDelete({
      path: "/proc/context/00_inbox/source.md", expectedVersion: seeded.version,
    })).resolves.toMatchObject({ status: "needs_confirmation" });
    expect(h.pending()).toMatchObject({ actionKind: "delete" });
  });

  it("keeps the proposal slot after a successful proposal", async () => {
    const h = harness();
    const seeded = await h.documents.put("owner", "context/00_inbox/source.md", "old text");

    await expect(h.capabilities.proposeDelete({
      path: "/proc/context/00_inbox/source.md", expectedVersion: seeded.version,
    })).resolves.toMatchObject({ status: "needs_confirmation" });
    await expect(h.capabilities.proposeUpdate({
      path: "/proc/context/00_inbox/source.md", expectedVersion: seeded.version, replacement: "new text",
    })).rejects.toThrow("only one pending action");
  });

  it("returns stale conflicts without creating a hidden pending action", async () => {
    const h = harness();
    const seeded = await h.documents.put("owner", "context/00_inbox/source.md", "old");
    const current = await h.documents.put("owner", seeded.path, "newer");
    await expect(h.tools.proposeContextDocumentDelete.execute?.({
      path: "/proc/context/00_inbox/source.md", expectedVersion: seeded.version,
    }, {} as never)).resolves.toEqual({ status: "conflict", currentVersion: current.version });
    expect(h.pending()).toBeUndefined();
  });
});
