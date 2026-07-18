import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { prioritizeContextDocuments } from "../../../src/application/assistant-context-projection.js";
import { loadContextPriorityManifest } from "../../../src/application/context-priority-manifest.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createOnboardingContextMaterializer } from "../../../src/application/onboarding-context-materializer.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";

const now = () => "2026-07-18T00:00:00.000Z";

describe("SPEC-PERSONAL-ASSISTANT-CONTEXT-PRIORITIES-001: trusted priority manifest", () => {
  it("sorts by manifest order and preserves source order for ties", () => {
    const manifest = loadFixture({
      version: 1,
      rules: [
        { id: "goals", pattern: "^/proc/context/(?:.*/)?02_цели_и_приоритеты\\.md$" },
        { id: "constitution", pattern: "^/proc/context/(?:.*/)?01_личная_конституция\\.md$" },
      ],
    });
    const documents = [
      document("context/00_inbox/z-first.md"),
      document("context/10_user_memory/01_личная_конституция.md"),
      document("context/10_user_memory/02_цели_и_приоритеты.md"),
      document("context/00_inbox/a-second.md"),
    ];

    const prioritized = prioritizeContextDocuments(documents, manifest);

    expect(prioritized.map(({ path }) => path)).toEqual([
      "context/10_user_memory/02_цели_и_приоритеты.md",
      "context/10_user_memory/01_личная_конституция.md",
      "context/00_inbox/z-first.md",
      "context/00_inbox/a-second.md",
    ]);
  });

  it("rejects empty, duplicate, unanchored, and malformed trusted manifests", () => {
    expect(() => loadFixture({ version: 1, rules: [] })).toThrow();
    expect(() => loadFixture({ version: 1, rules: [{ id: "same", pattern: "^/proc/context/a$" }, { id: "same", pattern: "^/proc/context/b$" }] })).toThrow("duplicate context priority rule id");
    expect(() => loadFixture({ version: 1, rules: [{ id: "a", pattern: "/proc/context/a" }] })).toThrow("must be anchored");
    expect(() => loadFixture({ version: 1, rules: [{ id: "a", pattern: "^[$" }] })).toThrow("invalid context priority rule pattern");
  });

  it("keeps owner documents unable to define priority policy", async () => {
    const manifest = loadContextPriorityManifest();
    const store = createInMemoryDocumentStore({ now });
    await store.put("owner", "context/context-priorities.json", JSON.stringify({ rules: [{ pattern: ".*" }] }));
    await store.put("owner", "context/10_user_memory/01_личная_конституция.md", "constitution");

    const prioritized = prioritizeContextDocuments(await store.list("owner", "context/"), manifest);

    expect(prioritized.map(({ path }) => path)).toEqual([
      "context/10_user_memory/01_личная_конституция.md",
      "context/context-priorities.json",
    ]);
  });

  it("keeps the onboarding constitution path covered by the first manifest rule", async () => {
    const manifest = loadContextPriorityManifest();
    const store = createInMemoryDocumentStore({ now });
    const ingestion = createIngestionService({ documentStore: store, blobStore: createInMemoryBlobStore({ now }) });
    const materializer = createOnboardingContextMaterializer({ documentStore: store, ingestionService: ingestion });

    const [constitution] = await materializer.materialize({ userId: "owner" });

    expect(constitution?.path).toBe("context/10_user_memory/01_личная_конституция.md");
    expect(manifest.rules[0]?.id).toBe("personal-constitution");
    expect(manifest.rules[0]?.matcher.test("/proc/context/10_user_memory/01_личная_конституция.md")).toBe(true);
  });
});

function document(path: string) {
  return { userId: "owner", path, content: path, version: "v1", updatedAt: now() };
}

function loadFixture(manifest: unknown) {
  const repoRoot = mkdtempSync(join(tmpdir(), "context-priorities-"));
  mkdirSync(join(repoRoot, "vault/assistant/proc"), { recursive: true });
  writeFileSync(join(repoRoot, "package.json"), "{}");
  writeFileSync(join(repoRoot, "vault/assistant/proc/context-priorities.json"), JSON.stringify(manifest));
  return loadContextPriorityManifest({ repoRoot });
}
