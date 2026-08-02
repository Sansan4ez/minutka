import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { renderAssistantContextSection, renderedAssistantContextDocumentCharacters } from "../../../src/application/assistant-context-renderer.js";
import { countUnicodeCharacters, createContextBudgetConfig } from "../../../src/application/context-budget.js";
import { discoverPilotKnowledgeBase, importPilotKnowledgeBase, migrateLegacyPilotKnowledgeBase, pilotUserIdFromEnv } from "../../../src/application/pilot-knowledge-base-import.js";
import { knowledgeBaseRootFromEnv, pilotKnowledgeBaseLimitsFromEnv, runPilotKnowledgeBaseImport } from "../../../src/runtime/import-pilot-knowledge-base.js";
import { createSyntheticPilotKnowledgeBase } from "../support/pilot-knowledge-base-fixture.js";

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
  it("uses one exact UTF-8 byte boundary for discovery, import, and ingestion", async () => {
    const root = mkdtempSync(join(tmpdir(), "pilot-knowledge-base-byte-boundary-"));
    roots.push(root);
    mkdirSync(join(root, "00_inbox"), { recursive: true });
    const sourcePath = join(root, "00_inbox", "unicode.md");
    writeFileSync(sourcePath, "🙂x");
    const exactBudget = createContextBudgetConfig({ documentTools: { maximumDocumentBytes: 5 } });
    const files = await discoverPilotKnowledgeBase(root, { contextBudget: exactBudget });
    expect(files).toEqual([expect.objectContaining({ path: "context/00_inbox/unicode.md", size: 5 })]);

    const clock = { now: () => "2026-07-16T00:00:00.000Z" };
    const documentStore = createInMemoryDocumentStore(clock);
    const ingestionService = createIngestionService({
      documentStore,
      blobStore: createInMemoryBlobStore(clock),
      maximumContextDocumentBytes: 5,
    });
    await expect(importPilotKnowledgeBase({
      userId: "pilot",
      files,
      documentStore,
      ingestionService,
      contextBudget: exactBudget,
    })).resolves.toMatchObject({ imported: 1, bytes: 5 });
    await expect(ingestionService.saveContextDocument({
      userId: "pilot",
      path: "context/00_inbox/exact.md",
      content: "🙂x",
    })).resolves.toMatchObject({ content: "🙂x" });

    writeFileSync(sourcePath, "🙂xx");
    await expect(discoverPilotKnowledgeBase(root, { contextBudget: exactBudget }))
      .rejects.toThrow("has 6 UTF-8 bytes and exceeds the 5-byte context document maximum");
    await expect(importPilotKnowledgeBase({
      userId: "pilot",
      files,
      documentStore,
      ingestionService,
      contextBudget: exactBudget,
    })).rejects.toThrow("has 6 UTF-8 bytes and exceeds the 5-byte context document maximum");
    await expect(ingestionService.saveContextDocument({
      userId: "pilot",
      path: "context/00_inbox/oversized.md",
      content: "🙂xx",
    })).rejects.toThrow("has 6 UTF-8 bytes and exceeds the 5-byte context document maximum");
  });

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

  it("uses source argument before env override and env override before the compatibility path", async () => {
    const sourceRoot = fixture();
    const envRoot = fixture();
    writeFileSync(join(sourceRoot, "10_user_memory", "source-only.md"), "source\n");
    writeFileSync(join(envRoot, "10_user_memory", "env-only.md"), "env\n");
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    expect(knowledgeBaseRootFromEnv({ PILOT_KNOWLEDGE_BASE_ROOT: `  ${envRoot}  ` })).toBe(envRoot);
    expect(knowledgeBaseRootFromEnv({ PILOT_KNOWLEDGE_BASE_ROOT: "  " })).toBeUndefined();

    await runPilotKnowledgeBaseImport({
      env: { PILOT_USER_ID: "pilot", PILOT_KNOWLEDGE_BASE_ROOT: envRoot },
      sourceRoot,
      dryRun: true,
    });
    expect(output.join("")).toContain("source-only.md");
    expect(output.join("")).not.toContain("env-only.md");

    output.length = 0;
    await runPilotKnowledgeBaseImport({ env: { PILOT_USER_ID: "pilot", PILOT_KNOWLEDGE_BASE_ROOT: envRoot }, dryRun: true });
    expect(output.join("")).toContain("env-only.md");
    expect(output.join("")).not.toContain("source-only.md");
  });

  it("imports through the owner boundary and makes retries idempotent", async () => {
    const root = fixture();
    const files = await discoverPilotKnowledgeBase(root);
    const { documentStore, ingestionService } = setup();

    const first = await importPilotKnowledgeBase({ userId: "pilot", files, documentStore, ingestionService });
    const retry = await importPilotKnowledgeBase({ userId: "pilot", files, documentStore, ingestionService });

    expect(first).toMatchObject({ imported: 3, skipped: 0 });
    expect(retry).toMatchObject({ imported: 0, skipped: 3 });
    expect(retry.files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "context/10_user_memory/01_goals.md", status: "skipped" },
      { path: "context/40_projects/project-a/README.MD", status: "skipped" },
      { path: "context/INDEX.md", status: "skipped" },
    ]);
    expect(await documentStore.list("pilot", "context/")).toHaveLength(3);
    expect(await documentStore.list("other-owner", "context/")).toEqual([]);
  });

  it("fails the complete import plan on a canonical conflict before the first write", async () => {
    const root = fixture();
    writeFileSync(join(root, "10_user_memory", "01_goals.md"), "# Workspace goals\n");
    writeFileSync(join(root, "40_projects", "project-a", "new.md"), "# New document\n");
    const files = await discoverPilotKnowledgeBase(root);
    const clock = { now: () => "2026-07-16T00:00:00.000Z" };
    const documentStore = createInMemoryDocumentStore(clock, [
      { userId: "pilot", path: "context/10_user_memory/01_goals.md", content: "# Canonical MinIO goals\n" },
    ]);
    const ensureContextDocument = vi.fn(createIngestionService({
      documentStore,
      blobStore: createInMemoryBlobStore(clock),
    }).ensureContextDocument);

    await expect(importPilotKnowledgeBase({
      userId: "pilot",
      files,
      documentStore,
      ingestionService: { ensureContextDocument },
    })).rejects.toThrow("knowledge-base import conflict: context/10_user_memory/01_goals.md");

    expect(ensureContextDocument).not.toHaveBeenCalled();
    await expect(documentStore.getExact("pilot", "context/40_projects/project-a/new.md")).resolves.toBeNull();
    await expect(documentStore.getExact("pilot", "context/10_user_memory/01_goals.md"))
      .resolves.toMatchObject({ content: "# Canonical MinIO goals\n" });
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

  it("preflights all legacy documents before writing a canonical migration tree", async () => {
    const clock = { now: () => "2026-07-16T00:00:00.000Z" };
    const firstLegacyPath = "context/imported-knowledge-base/00_inbox/valid.md";
    const invalidLegacyPath = "context/imported-knowledge-base/10_user_memory/01_Persona.md";
    const documentStore = createInMemoryDocumentStore(clock, [
      { userId: "pilot", path: firstLegacyPath, content: "valid non-core content" },
      { userId: "pilot", path: invalidLegacyPath, content: "<".repeat(30) },
    ]);
    const saveContextDocument = vi.fn(createIngestionService({
      documentStore,
      blobStore: createInMemoryBlobStore(clock),
    }).saveContextDocument);
    const contextPriorities = {
      version: 1 as const,
      rules: [{ id: "persona", pattern: "^/proc/context/10_user_memory/01_Persona\\.md$", matcher: /^\/proc\/context\/10_user_memory\/01_Persona\.md$/u }],
    };
    const contextBudget = createContextBudgetConfig({
      sources: { base_instructions: 0, agent_manual: 0, profile: 0, context: 100, context_index: 0 },
      projectionLimits: { contextDocumentCharacters: 100 },
    });

    await expect(migrateLegacyPilotKnowledgeBase({
      userId: "pilot",
      documentStore,
      ingestionService: { saveContextDocument },
      contextBudget,
      contextPriorities,
    })).rejects.toThrow("rendered per-file ceiling");

    expect(saveContextDocument).not.toHaveBeenCalled();
    await expect(documentStore.getExact("pilot", "context/00_inbox/valid.md")).resolves.toBeNull();
    await expect(documentStore.getExact("pilot", "context/10_user_memory/01_Persona.md")).resolves.toBeNull();
    await expect(documentStore.getExact("pilot", firstLegacyPath)).resolves.not.toBeNull();
    await expect(documentStore.getExact("pilot", invalidLegacyPath)).resolves.not.toBeNull();
  });

  it("rejects a late oversized legacy migration document before the first canonical write", async () => {
    const clock = { now: () => "2026-07-16T00:00:00.000Z" };
    const firstLegacyPath = "context/imported-knowledge-base/00_inbox/a.md";
    const oversizedLegacyPath = "context/imported-knowledge-base/00_inbox/z.md";
    const documentStore = createInMemoryDocumentStore(clock, [
      { userId: "pilot", path: firstLegacyPath, content: "ok" },
      { userId: "pilot", path: oversizedLegacyPath, content: "🙂xx" },
    ]);
    const saveContextDocument = vi.fn(createIngestionService({
      documentStore,
      blobStore: createInMemoryBlobStore(clock),
      maximumContextDocumentBytes: 5,
    }).saveContextDocument);
    const contextBudget = createContextBudgetConfig({ documentTools: { maximumDocumentBytes: 5 } });

    await expect(migrateLegacyPilotKnowledgeBase({
      userId: "pilot",
      documentStore,
      ingestionService: { saveContextDocument },
      contextBudget,
    })).rejects.toThrow("knowledge-base file context/00_inbox/z.md has 6 UTF-8 bytes and exceeds the 5-byte context document maximum");

    expect(saveContextDocument).not.toHaveBeenCalled();
    await expect(documentStore.getExact("pilot", "context/00_inbox/a.md")).resolves.toBeNull();
    await expect(documentStore.getExact("pilot", "context/00_inbox/z.md")).resolves.toBeNull();
    await expect(documentStore.getExact("pilot", firstLegacyPath)).resolves.not.toBeNull();
    await expect(documentStore.getExact("pilot", oversizedLegacyPath)).resolves.not.toBeNull();
  });

  it("does not block migration on an oversized legacy alias when no canonical write is planned", async () => {
    const clock = { now: () => "2026-07-16T00:00:00.000Z" };
    const canonicalPath = "context/00_inbox/legacy.md";
    const legacyPath = "context/imported-knowledge-base/00_inbox/legacy.md";
    const content = "🙂xx";
    const documentStore = createInMemoryDocumentStore(clock, [
      { userId: "pilot", path: canonicalPath, content },
      { userId: "pilot", path: legacyPath, content },
    ]);
    const saveContextDocument = vi.fn(createIngestionService({
      documentStore,
      blobStore: createInMemoryBlobStore(clock),
      maximumContextDocumentBytes: 5,
    }).saveContextDocument);

    await expect(migrateLegacyPilotKnowledgeBase({
      userId: "pilot",
      documentStore,
      ingestionService: { saveContextDocument },
      contextBudget: createContextBudgetConfig({ documentTools: { maximumDocumentBytes: 5 } }),
    })).resolves.toMatchObject({ migrated: 0, skipped: 1 });
    expect(saveContextDocument).not.toHaveBeenCalled();
  });

  it("rejects aggregate core overflow across existing canonical and planned legacy documents before writing", async () => {
    const clock = { now: () => "2026-07-16T00:00:00.000Z" };
    const existingPath = "context/10_user_memory/01_Persona.md";
    const legacyPath = "context/imported-knowledge-base/10_user_memory/02_Goals.md";
    const migratedPath = "context/10_user_memory/02_Goals.md";
    const existingContent = "<".repeat(30);
    const migratedContent = ">".repeat(30);
    const documentStore = createInMemoryDocumentStore(clock, [
      { userId: "pilot", path: existingPath, content: existingContent },
      { userId: "pilot", path: legacyPath, content: migratedContent },
    ]);
    const saveContextDocument = vi.fn(createIngestionService({
      documentStore,
      blobStore: createInMemoryBlobStore(clock),
    }).saveContextDocument);
    const contextPriorities = {
      version: 1 as const,
      rules: [
        { id: "persona", pattern: "^/proc/context/10_user_memory/01_Persona\\.md$", matcher: /^\/proc\/context\/10_user_memory\/01_Persona\.md$/u },
        { id: "goals", pattern: "^/proc/context/10_user_memory/02_Goals\\.md$", matcher: /^\/proc\/context\/10_user_memory\/02_Goals\.md$/u },
      ],
    };
    const existingRendered = countUnicodeCharacters(renderAssistantContextSection({
      documents: [{ path: "/proc/context/10_user_memory/01_Persona.md", content: existingContent, representation: "full" }],
      truncated: false,
    }));
    const contextBudget = createContextBudgetConfig({
      sources: { base_instructions: 0, agent_manual: 0, profile: 0, context: existingRendered, context_index: 0 },
      projectionLimits: { contextDocumentCharacters: existingRendered },
    });

    await expect(migrateLegacyPilotKnowledgeBase({
      userId: "pilot",
      documentStore,
      ingestionService: { saveContextDocument },
      contextBudget,
      contextPriorities,
    })).rejects.toThrow("rendered context ceiling");

    expect(saveContextDocument).not.toHaveBeenCalled();
    await expect(documentStore.getExact("pilot", migratedPath)).resolves.toBeNull();
    await expect(documentStore.getExact("pilot", existingPath)).resolves.toMatchObject({ content: existingContent });
    await expect(documentStore.getExact("pilot", legacyPath)).resolves.toMatchObject({ content: migratedContent });
  });

  it("passes the CLI env budget and trusted manifest into legacy migration", async () => {
    const root = fixture();
    const clock = { now: () => "2026-07-16T00:00:00.000Z" };
    const legacyPath = "context/imported-knowledge-base/30_knowledge/runtime-core.md";
    const canonicalPath = "context/30_knowledge/runtime-core.md";
    const documentStore = createInMemoryDocumentStore(clock, [
      { userId: "pilot", path: legacyPath, content: "<".repeat(30) },
    ]);
    const contextPriorities = {
      version: 1 as const,
      rules: [{ id: "runtime-core", pattern: "^/proc/context/30_knowledge/runtime-core\\.md$", matcher: /^\/proc\/context\/30_knowledge\/runtime-core\.md$/u }],
    };

    await expect(runPilotKnowledgeBaseImport({
      env: {
        PILOT_USER_ID: "pilot",
        ASSISTANT_CONTEXT_SOURCE_BASE_INSTRUCTIONS_CHARACTERS: "0",
        ASSISTANT_CONTEXT_SOURCE_AGENT_MANUAL_CHARACTERS: "0",
        ASSISTANT_CONTEXT_SOURCE_PROFILE_CHARACTERS: "0",
        ASSISTANT_CONTEXT_SOURCE_CONTEXT_CHARACTERS: "1000",
        ASSISTANT_CONTEXT_SOURCE_CONTEXT_INDEX_CHARACTERS: "0",
        ASSISTANT_CONTEXT_DOCUMENT_CHARACTERS: "100",
      },
      sourceRoot: root,
      migrateLegacy: true,
      dependencies: {
        prepareDocumentStore: async () => documentStore,
        loadContextPriorities: () => contextPriorities,
      },
    })).rejects.toThrow("rendered per-file ceiling");

    await expect(documentStore.getExact("pilot", canonicalPath)).resolves.toBeNull();
    await expect(documentStore.getExact("pilot", legacyPath)).resolves.not.toBeNull();
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

  it("accepts a synthetic deep and wide tree with the INDEX.md convention", async () => {
    const fixture = createSyntheticPilotKnowledgeBase();
    roots.push(fixture.root);
    const files = await discoverPilotKnowledgeBase(fixture.root);
    expect(files).toHaveLength(fixture.documentCount);
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "context/INDEX.md" }),
      expect.objectContaining({ path: "context/10_user_memory/INDEX.md" }),
      expect.objectContaining({ path: "context/40_projects/alpha/planning/design/INDEX.md" }),
      expect.objectContaining({ path: fixture.deepDocumentPath }),
      expect.objectContaining({ path: fixture.wideDocumentPath }),
      expect.objectContaining({ path: "context/90_agent_memory/INDEX.md" }),
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

  it("rejects core documents that cannot fit configured rendered import ceilings", async () => {
    const root = fixture();
    writeFileSync(join(root, "10_user_memory", "01_Persona.md"), "<".repeat(30));
    const contextPriorities = {
      version: 1 as const,
      rules: [{ id: "persona", pattern: "^/proc/context/10_user_memory/01_Persona\\.md$", matcher: /^\/proc\/context\/10_user_memory\/01_Persona\.md$/u }],
    };
    const contextBudget = createContextBudgetConfig({
      sources: { base_instructions: 0, agent_manual: 0, profile: 0, context: 100, context_index: 0 },
      projectionLimits: { contextDocumentCharacters: 100 },
    });
    await expect(discoverPilotKnowledgeBase(root, { contextBudget, contextPriorities })).rejects.toThrow("rendered per-file ceiling");
    const files = await discoverPilotKnowledgeBase(root, { contextBudget: createContextBudgetConfig({
      sources: { base_instructions: 0, agent_manual: 0, profile: 0, context: 1_000, context_index: 0 },
      projectionLimits: { contextDocumentCharacters: 500 },
    }), contextPriorities });
    writeFileSync(join(root, "10_user_memory", "01_Persona.md"), "<".repeat(60));
    const { documentStore, ingestionService } = setup();
    await expect(importPilotKnowledgeBase({ userId: "pilot", files, documentStore, ingestionService, contextBudget, contextPriorities }))
      .rejects.toThrow("rendered per-file ceiling");
  });

  it("validates partial imports against untouched core documents and preserves the canonical tree on failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "pilot-knowledge-base-partial-import-"));
    roots.push(root);
    mkdirSync(join(root, "10_user_memory"), { recursive: true });
    const plannedContent = "&".repeat(30);
    writeFileSync(join(root, "10_user_memory", "02_Goals.md"), plannedContent);
    const existingPath = "context/10_user_memory/01_Persona.md";
    const existingContent = "<".repeat(30);
    const clock = { now: () => "2026-07-16T00:00:00.000Z" };
    const documentStore = createInMemoryDocumentStore(clock, [
      { userId: "pilot", path: existingPath, content: existingContent },
    ]);
    const ensureContextDocument = vi.fn(createIngestionService({
      documentStore,
      blobStore: createInMemoryBlobStore(clock),
    }).ensureContextDocument);
    const contextPriorities = {
      version: 1 as const,
      rules: [
        { id: "persona", pattern: "^/proc/context/10_user_memory/01_Persona\\.md$", matcher: /^\/proc\/context\/10_user_memory\/01_Persona\.md$/u },
        { id: "goals", pattern: "^/proc/context/10_user_memory/02_Goals\\.md$", matcher: /^\/proc\/context\/10_user_memory\/02_Goals\.md$/u },
      ],
    };
    const files = await discoverPilotKnowledgeBase(root, {
      contextBudget: createContextBudgetConfig({
        sources: { base_instructions: 0, agent_manual: 0, profile: 0, context: 1_000, context_index: 0 },
        projectionLimits: { contextDocumentCharacters: 500 },
      }),
      contextPriorities,
    });
    const existingRendered = countUnicodeCharacters(renderAssistantContextSection({
      documents: [{ path: "/proc/context/10_user_memory/01_Persona.md", content: existingContent, representation: "full" }],
      truncated: false,
    }));
    const contextBudget = createContextBudgetConfig({
      sources: { base_instructions: 0, agent_manual: 0, profile: 0, context: existingRendered, context_index: 0 },
      projectionLimits: { contextDocumentCharacters: existingRendered },
    });

    await expect(importPilotKnowledgeBase({
      userId: "pilot",
      files,
      documentStore,
      ingestionService: { ensureContextDocument },
      contextBudget,
      contextPriorities,
    })).rejects.toThrow("rendered context ceiling");

    expect(ensureContextDocument).not.toHaveBeenCalled();
    await expect(documentStore.getExact("pilot", "context/10_user_memory/02_Goals.md")).resolves.toBeNull();
    await expect(documentStore.getExact("pilot", existingPath)).resolves.toMatchObject({ content: existingContent });
  });

  it("gives canonical documents precedence over legacy aliases in final-state validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "pilot-knowledge-base-alias-precedence-"));
    roots.push(root);
    mkdirSync(join(root, "00_inbox"), { recursive: true });
    writeFileSync(join(root, "00_inbox", "note.md"), "ordinary import");
    const canonicalPath = "context/10_user_memory/01_Persona.md";
    const legacyPath = "context/imported-knowledge-base/10_user_memory/01_Persona.md";
    const canonicalContent = "canonical";
    const clock = { now: () => "2026-07-16T00:00:00.000Z" };
    const documentStore = createInMemoryDocumentStore(clock, [
      { userId: "pilot", path: legacyPath, content: "<".repeat(200) },
      { userId: "pilot", path: canonicalPath, content: canonicalContent },
    ]);
    const ingestionService = createIngestionService({ documentStore, blobStore: createInMemoryBlobStore(clock) });
    const contextPriorities = {
      version: 1 as const,
      rules: [{ id: "persona", pattern: "^/proc/context/10_user_memory/01_Persona\\.md$", matcher: /^\/proc\/context\/10_user_memory\/01_Persona\.md$/u }],
    };
    const core = { path: "/proc/context/10_user_memory/01_Persona.md", content: canonicalContent, representation: "full" as const };
    const contextBudget = createContextBudgetConfig({
      sources: {
        base_instructions: 0,
        agent_manual: 0,
        profile: 0,
        context: countUnicodeCharacters(renderAssistantContextSection({ documents: [core], truncated: true })),
        context_index: 0,
      },
      projectionLimits: { contextDocumentCharacters: renderedAssistantContextDocumentCharacters(core) },
    });
    const files = await discoverPilotKnowledgeBase(root, {
      contextBudget: createContextBudgetConfig({
        sources: { base_instructions: 0, agent_manual: 0, profile: 0, context: 1_000, context_index: 0 },
        projectionLimits: { contextDocumentCharacters: 500 },
      }),
      contextPriorities,
    });

    await expect(importPilotKnowledgeBase({
      userId: "pilot",
      files,
      documentStore,
      ingestionService,
      contextBudget,
      contextPriorities,
    })).resolves.toMatchObject({ imported: 1 });
    await expect(documentStore.getExact("pilot", canonicalPath)).resolves.toMatchObject({ content: canonicalContent });
    await expect(documentStore.getExact("pilot", legacyPath)).resolves.toMatchObject({ content: "<".repeat(200) });
  });

  it("reserves the exact degradation marker for non-core files during discover and import preflight", async () => {
    const root = fixture();
    const coreContent = "<".repeat(80);
    writeFileSync(join(root, "10_user_memory", "01_Persona.md"), coreContent);
    const core = {
      path: "/proc/context/10_user_memory/01_Persona.md",
      content: coreContent,
      representation: "full" as const,
    };
    const contextPriorities = {
      version: 1 as const,
      rules: [{ id: "persona", pattern: "^/proc/context/10_user_memory/01_Persona\\.md$", matcher: /^\/proc\/context\/10_user_memory\/01_Persona\.md$/u }],
    };
    const contextBudget = createContextBudgetConfig({
      sources: {
        base_instructions: 0,
        agent_manual: 0,
        profile: 0,
        context: countUnicodeCharacters(renderAssistantContextSection({ documents: [core], truncated: false })),
        context_index: 0,
      },
      projectionLimits: { contextDocumentCharacters: renderedAssistantContextDocumentCharacters(core) },
    });

    await expect(discoverPilotKnowledgeBase(root, { contextBudget, contextPriorities })).rejects.toThrow("rendered context ceiling");

    const files = await discoverPilotKnowledgeBase(root, {
      contextBudget: createContextBudgetConfig({
        sources: { base_instructions: 0, agent_manual: 0, profile: 0, context: 2_000, context_index: 0 },
        projectionLimits: { contextDocumentCharacters: 1_000 },
      }),
      contextPriorities,
    });
    const { documentStore, ingestionService } = setup();
    await expect(importPilotKnowledgeBase({ userId: "pilot", files, documentStore, ingestionService, contextBudget, contextPriorities }))
      .rejects.toThrow("rendered context ceiling");
    expect(await documentStore.list("pilot", "context/")).toEqual([]);
  });

  it("rejects unknown top-level entries", async () => {
    const root = fixture();
    writeFileSync(join(root, "secret.env"), "TOKEN=secret");
    await expect(discoverPilotKnowledgeBase(root)).rejects.toThrow("not allow-listed");
  });

  it.each(["note.txt", "transcript.vtt", "paper.pdf", "image.png", "audio.ogg", "video.mp4", "unknown.bin"])(
    "rejects non-Markdown file %s with a relative path before MinIO is prepared",
    async (fileName) => {
      const root = fixture();
      mkdirSync(join(root, "00_inbox"), { recursive: true });
      writeFileSync(join(root, "00_inbox", fileName), "private owner content");
      const prepareDocumentStore = vi.fn();

      await expect(runPilotKnowledgeBaseImport({
        env: { PILOT_USER_ID: "private-owner-id" },
        sourceRoot: root,
        dependencies: { prepareDocumentStore },
      })).rejects.toThrow(`knowledge-base file type is not allow-listed: 00_inbox/${fileName}`);

      expect(prepareDocumentStore).not.toHaveBeenCalled();
      try {
        await discoverPilotKnowledgeBase(root);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).not.toContain("private owner content");
        expect(message).not.toContain("private-owner-id");
      }
    },
  );

  it("rejects aggregate document count and UTF-8 bytes before the first write", async () => {
    const root = fixture();
    const files = await discoverPilotKnowledgeBase(root, {
      limits: { maximumDocuments: 3, maximumTotalBytes: 1_000 },
    });
    const { documentStore } = setup();
    const ensureContextDocument = vi.fn();

    await expect(importPilotKnowledgeBase({
      userId: "pilot",
      files,
      documentStore,
      ingestionService: { ensureContextDocument },
      limits: { maximumDocuments: 2, maximumTotalBytes: 1_000 },
    })).rejects.toThrow("exceeds the 2-document maximum");
    expect(ensureContextDocument).not.toHaveBeenCalled();

    await expect(importPilotKnowledgeBase({
      userId: "pilot",
      files,
      documentStore,
      ingestionService: { ensureContextDocument },
      limits: { maximumDocuments: 3, maximumTotalBytes: 10 },
    })).rejects.toThrow("UTF-8 bytes and exceeds the 10-byte maximum");
    expect(ensureContextDocument).not.toHaveBeenCalled();

    await expect(discoverPilotKnowledgeBase(root, {
      limits: { maximumDocuments: 2, maximumTotalBytes: 1_000 },
    })).rejects.toThrow("exceeds the 2-document maximum");
    await expect(discoverPilotKnowledgeBase(root, {
      limits: { maximumDocuments: 3, maximumTotalBytes: 10 },
    })).rejects.toThrow("UTF-8 bytes and exceeds the 10-byte maximum");
  });

  it("loads configurable aggregate limits from the import environment", () => {
    expect(pilotKnowledgeBaseLimitsFromEnv({
      PILOT_KNOWLEDGE_BASE_MAX_DOCUMENTS: " 42 ",
      PILOT_KNOWLEDGE_BASE_MAX_TOTAL_BYTES: " 4096 ",
    })).toEqual({ maximumDocuments: 42, maximumTotalBytes: 4096 });
    expect(() => pilotKnowledgeBaseLimitsFromEnv({ PILOT_KNOWLEDGE_BASE_MAX_DOCUMENTS: "0" }))
      .toThrow("PILOT_KNOWLEDGE_BASE_MAX_DOCUMENTS must be a positive safe integer");
    expect(() => pilotKnowledgeBaseLimitsFromEnv({ PILOT_KNOWLEDGE_BASE_MAX_TOTAL_BYTES: "many" }))
      .toThrow("PILOT_KNOWLEDGE_BASE_MAX_TOTAL_BYTES must be a positive integer");
  });

  it("allows root Git metadata and a root symlink to a directory", async () => {
    const root = fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await expect(discoverPilotKnowledgeBase(root)).resolves.toHaveLength(3);
    const bridgeParent = mkdtempSync(join(tmpdir(), "pilot-knowledge-base-bridge-"));
    roots.push(bridgeParent);
    const bridge = join(bridgeParent, "knowledge_base");
    symlinkSync(root, bridge, "dir");

    await expect(discoverPilotKnowledgeBase(bridge)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "context/10_user_memory/01_goals.md" }),
    ]));
  });

  it("rejects nested, broken, and file-target source symlinks", async () => {
    const root = fixture();
    symlinkSync(join(root, "10_user_memory", "01_goals.md"), join(root, "10_user_memory", "linked.md"));
    await expect(discoverPilotKnowledgeBase(root)).rejects.toThrow("symlinks are not allowed");

    const bridgeParent = mkdtempSync(join(tmpdir(), "pilot-knowledge-base-invalid-bridge-"));
    roots.push(bridgeParent);
    const brokenBridge = join(bridgeParent, "broken");
    symlinkSync(join(bridgeParent, "missing"), brokenBridge);
    await expect(discoverPilotKnowledgeBase(brokenBridge)).rejects.toThrow("source symlink is broken");

    const fileBridge = join(bridgeParent, "file");
    symlinkSync(join(root, "INDEX.md"), fileBridge);
    await expect(discoverPilotKnowledgeBase(fileBridge)).rejects.toThrow("source symlink must target a directory");
  });
});
