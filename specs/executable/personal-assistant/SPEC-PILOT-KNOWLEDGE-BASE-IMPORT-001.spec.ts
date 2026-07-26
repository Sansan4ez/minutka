import { cpSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createContextBudgetConfig } from "../../../src/application/context-budget.js";
import { discoverPilotKnowledgeBase, importPilotKnowledgeBase, migrateLegacyPilotKnowledgeBase, pilotUserIdFromEnv } from "../../../src/application/pilot-knowledge-base-import.js";
import { runPilotKnowledgeBaseImport } from "../../../src/runtime/import-pilot-knowledge-base.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "pilot-knowledge-base-"));
  roots.push(root);
  mkdirSync(join(root, "10_user_memory"), { recursive: true });
  mkdirSync(join(root, "40_projects", "project-a"), { recursive: true });
  writeFileSync(join(root, "10_user_memory", "01_goals.md"), "# Goals\nShip safely.\n");
  writeFileSync(join(root, "40_projects", "project-a", "README.MD"), "# Project A\n");
  writeFileSync(join(root, "INDEX.md"), "# Owner index\nUntrusted navigation data.\n");
  return root;
}

function setup() {
  const clock = { now: () => "2026-07-16T00:00:00.000Z" };
  const documentStore = createInMemoryDocumentStore(clock);
  const ingestionService = createIngestionService({ documentStore, blobStore: createInMemoryBlobStore(clock) });
  return { documentStore, ingestionService };
}

describe("SPEC-PILOT-KNOWLEDGE-BASE-IMPORT-001: safe owner-scoped migration", () => {
  it("fails closed without an explicit pilot owner", () => {
    expect(() => pilotUserIdFromEnv({})).toThrow("PILOT_USER_ID is required");
    expect(() => pilotUserIdFromEnv({ PILOT_USER_ID: "owner/other" })).toThrow("invalid userId");
  });

  it("prints deterministic dry-run metadata without reading MinIO or exposing contents", async () => {
    const root = fixture();
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    await runPilotKnowledgeBaseImport({ env: { PILOT_USER_ID: "pilot" }, sourceRoot: root, dryRun: true });

    const rendered = output.join("");
    expect(rendered).toContain('"path": "context/10_user_memory/01_goals.md"');
    expect(rendered).toContain('"size": 21');
    expect(rendered).not.toContain("Ship safely");
    expect(rendered).not.toContain("pilot");
  });

  it("imports through the owner boundary and makes retries idempotent", async () => {
    const root = fixture();
    const files = await discoverPilotKnowledgeBase(root);
    const { documentStore, ingestionService } = setup();

    const first = await importPilotKnowledgeBase({ userId: "pilot", files, documentStore, ingestionService });
    const retry = await importPilotKnowledgeBase({ userId: "pilot", files, documentStore, ingestionService });

    expect(first).toMatchObject({ imported: 3, updated: 0, skipped: 0 });
    expect(retry).toMatchObject({ imported: 0, updated: 0, skipped: 3 });
    expect(retry.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "context/10_user_memory/01_goals.md", status: "skipped" },
      { path: "context/40_projects/project-a/README.MD", status: "skipped" },
      { path: "context/INDEX.md", status: "skipped" },
    ]);
    expect(await documentStore.list("pilot", "context/")).toHaveLength(3);
    expect(await documentStore.list("other-owner", "context/")).toEqual([]);
  });

  it("reads legacy aliases, migrates them idempotently, and fails closed on collisions", async () => {
    const clock = { now: () => "2026-07-16T00:00:00.000Z" };
    const legacyGoalsPath = "context/imported-knowledge-base/10_user_memory/01_goals.md";
    const documentStore = createInMemoryDocumentStore(clock, [
      { userId: "pilot", path: legacyGoalsPath, content: "# Legacy goals\n" },
    ]);
    const ingestionService = createIngestionService({ documentStore, blobStore: createInMemoryBlobStore(clock) });

    await expect(documentStore.get("pilot", "context/10_user_memory/01_goals.md")).resolves.toMatchObject({
      path: "context/10_user_memory/01_goals.md",
      content: "# Legacy goals\n",
    });
    await expect(documentStore.get("other-owner", "context/10_user_memory/01_goals.md")).resolves.toBeNull();
    expect((await documentStore.list("pilot", "context/")).map(({ path }) => path)).toEqual([
      "context/10_user_memory/01_goals.md",
    ]);

    const first = await migrateLegacyPilotKnowledgeBase({ userId: "pilot", documentStore, ingestionService });
    const retry = await migrateLegacyPilotKnowledgeBase({ userId: "pilot", documentStore, ingestionService });
    expect(first).toMatchObject({ migrated: 1, skipped: 0 });
    expect(retry).toMatchObject({ migrated: 0, skipped: 1 });
    expect(await documentStore.getExact("pilot", legacyGoalsPath)).not.toBeNull();

    const legacyProjectPath = "context/imported-knowledge-base/40_projects/project-a/README.MD";
    const collisionStore = createInMemoryDocumentStore(clock, [
      { userId: "pilot", path: legacyProjectPath, content: "legacy content" },
    ]);
    const collisionIngestion = createIngestionService({ documentStore: collisionStore, blobStore: createInMemoryBlobStore(clock) });
    await collisionStore.put("pilot", "context/40_projects/project-a/README.MD", "different canonical content");
    await expect(migrateLegacyPilotKnowledgeBase({ userId: "pilot", documentStore: collisionStore, ingestionService: collisionIngestion }))
      .rejects.toThrow("knowledge-base migration collision");
  });

  it("canonicalizes logical writes and deletes while preserving legacy owner content on create", async () => {
    const clock = { now: () => "2026-07-16T00:00:00.000Z" };
    const legacyPath = "context/imported-knowledge-base/10_user_memory/01_goals.md";
    const canonicalPath = "context/10_user_memory/01_goals.md";
    const documentStore = createInMemoryDocumentStore(clock, [
      { userId: "pilot", path: legacyPath, content: "legacy owner content" },
    ]);

    await expect(documentStore.putIfAbsent("pilot", canonicalPath, "scaffold")).resolves.toMatchObject({
      path: canonicalPath,
      content: "legacy owner content",
    });
    await expect(documentStore.getExact("pilot", canonicalPath)).resolves.toBeNull();

    await expect(documentStore.put("pilot", legacyPath, "canonical update")).resolves.toMatchObject({ path: canonicalPath });
    await expect(documentStore.getExact("pilot", canonicalPath)).resolves.toMatchObject({ content: "canonical update" });

    await documentStore.delete("pilot", legacyPath);
    await expect(documentStore.get("pilot", canonicalPath)).resolves.toBeNull();
    await expect(documentStore.getExact("pilot", legacyPath)).resolves.toBeNull();
  });

  it("rejects case and Unicode-normalization collisions", async () => {
    const root = fixture();
    writeFileSync(join(root, "10_user_memory", "index.md"), "lowercase");
    writeFileSync(join(root, "10_user_memory", "INDEX.md"), "uppercase");
    await expect(discoverPilotKnowledgeBase(root)).rejects.toThrow("collide");
  });

  it("fails closed on the retired root AGENTS.MD navigation name", async () => {
    const root = fixture();
    writeFileSync(join(root, "AGENTS.MD"), "retired owner navigation name");
    await expect(discoverPilotKnowledgeBase(root)).rejects.toThrow("not allow-listed");
  });

  it("accepts the repository pilot tree with the INDEX.md convention", async () => {
    const root = mkdtempSync(join(tmpdir(), "pilot-knowledge-base-repo-copy-"));
    roots.push(root);
    cpSync("vault/user/knowledge_base", root, { recursive: true });
    const files = await discoverPilotKnowledgeBase(root);
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "context/INDEX.md" }),
      expect.objectContaining({ path: "context/10_user_memory/INDEX.md" }),
      expect.objectContaining({ path: "context/90_agent_memory/INDEX.md" }),
      expect.objectContaining({ path: "context/99_system/schemas/INDEX.md" }),
      expect.objectContaining({ path: "context/99_system/workflows/INDEX.md" }),
    ]));
    expect(files.some(({ path }) => path.endsWith("/AGENTS.MD"))).toBe(false);
  });

  it("validates INDEX.md links and path-like code spans as existing direct children", async () => {
    const root = fixture();
    writeFileSync(join(root, "INDEX.md"), "- [memory](10_user_memory/)\n");
    await expect(discoverPilotKnowledgeBase(root)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "context/INDEX.md" }),
    ]));

    writeFileSync(join(root, "INDEX.md"), "- [missing](missing/)\n");
    await expect(discoverPilotKnowledgeBase(root)).rejects.toThrow("link does not exist");

    writeFileSync(join(root, "INDEX.md"), "- [deep](40_projects/project-a/)\n");
    await expect(discoverPilotKnowledgeBase(root)).rejects.toThrow("only direct children");
    writeFileSync(join(root, "INDEX.md"), "# Owner index\nUntrusted navigation data.\n");

    writeFileSync(join(root, "10_user_memory", "INDEX.md"), "- `01_goals.md`\n");
    await expect(discoverPilotKnowledgeBase(root)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "context/10_user_memory/INDEX.md" }),
    ]));

    writeFileSync(join(root, "10_user_memory", "INDEX.md"), "- `01_goalz.md`\n");
    await expect(discoverPilotKnowledgeBase(root)).rejects.toThrow("code-span does not exist");
  });

  it("rejects core documents that cannot fit configured import ceilings", async () => {
    const root = fixture();
    writeFileSync(join(root, "10_user_memory", "01_Persona.md"), "P".repeat(101));
    const contextPriorities = {
      version: 1 as const,
      rules: [{ id: "persona", pattern: "^/proc/context/10_user_memory/01_Persona\\.md$", matcher: /^\/proc\/context\/10_user_memory\/01_Persona\.md$/u }],
    };
    const contextBudget = createContextBudgetConfig({
      sources: { base_instructions: 0, agent_manual: 0, profile: 0, context: 100, context_index: 0 },
      projectionLimits: { contextDocumentCharacters: 100 },
    });
    await expect(discoverPilotKnowledgeBase(root, { contextBudget, contextPriorities })).rejects.toThrow("core document");
  });

  it("rejects unknown top-level entries", async () => {
    const root = fixture();
    writeFileSync(join(root, "secret.env"), "TOKEN=secret");
    await expect(discoverPilotKnowledgeBase(root)).rejects.toThrow("not allow-listed");
  });

  it("rejects symlinks inside the allow-listed tree", async () => {
    const root = fixture();
    symlinkSync(join(root, "10_user_memory", "01_goals.md"), join(root, "10_user_memory", "linked.md"));
    await expect(discoverPilotKnowledgeBase(root)).rejects.toThrow("symlinks are not allowed");
  });
});
