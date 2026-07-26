import { describe, expect, it } from "vitest";
import { createAssistantContextProjectionBuilder, renderAssistantContextProjection } from "../../../src/application/assistant-context-projection.js";
import { createContextBudgetConfig, countUnicodeCharacters } from "../../../src/application/context-budget.js";
import { renderContextTreeIndex } from "../../../src/application/context-tree-index.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import type { UserDocumentMetadata } from "../../../src/application/document-store.js";

const now = "2026-07-18T09:00:00.000Z";

function metadata(path: string, size = 100, updatedAt = now): UserDocumentMetadata {
  return { userId: "owner", path: `context/${path}`, version: `v-${path}`, updatedAt, size };
}

describe("SPEC-PERSONAL-ASSISTANT-CONTEXT-INDEX-001: metadata-only context tree map", () => {
  it("renders empty and single-file trees with logical handles and read guidance", () => {
    const empty = renderContextTreeIndex({ documents: [], ceiling: 6_000, depth: 4 });
    expect(empty).toMatchObject({ level: "files", documentCount: 0 });
    expect(empty.text).toContain("(empty)");

    const single = renderContextTreeIndex({ documents: [metadata("заметки/цели🙂.md", 321)], ceiling: 6_000, depth: 4 });
    expect(single.level).toBe("files");
    expect(single.text).toContain("/proc/context/");
    expect(single.text).toContain("  заметки/");
    expect(single.text).toContain("    цели🙂.md (321 B, 2026-07-18)");
    expect(single.text).toContain("readDocument(path)");
    expect(single.text).not.toContain("context/imported-knowledge-base");
  });

  it("is stable by code-point path order regardless of storage order", () => {
    const documents = [metadata("я.md"), metadata("a.md"), metadata("Б.md"), metadata("🙂.md")];
    const forward = renderContextTreeIndex({ documents, ceiling: 6_000, depth: 4 }).text;
    const reverse = renderContextTreeIndex({ documents: [...documents].reverse(), ceiling: 6_000, depth: 4 }).text;
    expect(reverse).toBe(forward);
    expect(forward.indexOf("a.md")).toBeLessThan(forward.indexOf("Б.md"));
    expect(forward.indexOf("Б.md")).toBeLessThan(forward.indexOf("я.md"));
    expect(forward.indexOf("я.md")).toBeLessThan(forward.indexOf("🙂.md"));
  });

  it("renders a 141-file bounded-depth tree without flattening its paths", () => {
    const documents = Array.from({ length: 141 }, (_, index) => metadata(`30_knowledge/topic-${index % 7}/note-${String(index).padStart(3, "0")}.md`, 200 + index));
    const index = renderContextTreeIndex({ documents, ceiling: 20_000, depth: 4 });
    expect(index.level).toBe("files");
    expect(index.documentCount).toBe(141);
    expect(index.text).toContain("  30_knowledge/");
    expect(index.text).toContain("    topic-0/");
    expect(index.text).toContain("      note-000.md");
  });

  it("uses deterministic depth rollups before the character-ceiling ladder", () => {
    const index = renderContextTreeIndex({
      documents: [metadata("one/two/three/four/deep.md", 77)],
      ceiling: 6_000,
      depth: 2,
    });
    expect(index.level).toBe("files");
    expect(index.text).toContain("    two/ (1 files, 77 B");
    expect(index.text).toContain("depth rollup");
    expect(index.text).not.toContain("deep.md");
  });

  it("falls back from files to folder rollup and then top-level without silent truncation", () => {
    const documents = Array.from({ length: 2_000 }, (_, index) => metadata(`folder-${index % 20}/nested-${index % 5}/very-long-document-${String(index).padStart(4, "0")}.md`, 1_000));
    const fileText = renderContextTreeIndex({ documents, ceiling: 1_000_000, depth: 4 }).text;
    const folderCeiling = 40_000;
    const folderText = renderContextTreeIndex({ documents, ceiling: folderCeiling, depth: 4 });
    expect(folderText.level).toBe("folders");
    expect(folderText.text).toContain("documents: 2000");
    expect(folderText.text).not.toContain("very-long-document-0000.md");

    const topLevel = renderContextTreeIndex({ documents, ceiling: 1_500, depth: 4 });
    expect(topLevel.level).toBe("top-level");
    expect(topLevel.text).toContain("documents: 2000");
    expect(topLevel.text).toContain("folder-0/ (100 files, 100000 B");
    expect(countUnicodeCharacters(folderText.text)).toBeLessThanOrEqual(folderCeiling);
    expect(countUnicodeCharacters(fileText)).toBeGreaterThan(countUnicodeCharacters(folderText.text));
    expect(countUnicodeCharacters(folderText.text)).toBeGreaterThan(countUnicodeCharacters(topLevel.text));
  });

  it("builds the index through listMetadata and keeps it visible after core documents", async () => {
    const store = createInMemoryDocumentStore({ now: () => now }, [
      { userId: "owner", path: "context/core.md", content: "CORE" },
      { userId: "owner", path: "context/archive/hidden.md", content: "HIDDEN" },
    ]);
    let metadataCalls = 0;
    let bodyGetCalls = 0;
    const projection = await createAssistantContextProjectionBuilder({
      documentStore: {
        ...store,
        async listMetadata(userId, prefix) {
          metadataCalls += 1;
          return store.listMetadata(userId, prefix);
        },
        async get(userId, path) {
          bodyGetCalls += 1;
          return store.get(userId, path);
        },
        async list() {
          throw new Error("projection must not list document bodies");
        },
      },
      now: () => now,
      contextBudget: createContextBudgetConfig({ projectionLimits: { contextDocuments: 1, contextIndexDepth: 4 } }),
      contextPriorities: { version: 1, rules: [{ id: "core", pattern: "^/proc/context/core\\.md$", matcher: /^\/proc\/context\/core\.md$/u }] },
    }).build({ userId: "owner", requestId: "request" });

    expect(metadataCalls).toBe(1);
    expect(bodyGetCalls).toBe(1);
    expect(projection.data.documents.map(({ path }) => path)).toEqual(["/proc/context/core.md"]);
    expect(projection.data.index.text).toContain("archive/");
    expect(projection.data.index.text).toContain("hidden.md");
    const rendered = `${renderAssistantContextProjection(projection)}\n\n${projection.data.index.text}`;
    expect(rendered.indexOf("CORE")).toBeLessThan(rendered.indexOf("Machine index: /proc/context"));
  });
});
