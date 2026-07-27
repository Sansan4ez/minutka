import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contextBudgetConfigFromEnv, createContextBudgetConfig } from "../../../src/application/context-budget.js";
import { createOwnerDocumentReader, documentReadLimits } from "../../../src/application/document-reader.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import type { DocumentStore } from "../../../src/application/document-store.js";
import { assistantDocumentToolNames, createDocumentTools } from "../../../src/mastra/tools/document-tools.js";

const clock = { now: () => "2026-07-16T12:00:00.000Z" };

async function fixture() {
  const store = createInMemoryDocumentStore(clock);
  await store.put("owner", "context/10_user_memory/01_личная_конституция.md", [
    "# Личная конституция",
    "",
    "## Принципы",
    "Сначала ясность, затем скорость.",
    "",
    "## Ритм",
    "Беречь утренний фокус.",
  ].join("\n"));
  await store.put("owner", "context/90_agent_memory/soul.md", "Тон: коротко и по делу.");
  await store.put("other", "context/10_user_memory/private.md", "чужой секрет");
  return store;
}

describe("SPEC-PERSONAL-ASSISTANT-DOCUMENT-TOOLS-001: bounded owner document capabilities", () => {
  it("lists logical paths with cursor pagination and no physical storage details", async () => {
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: await fixture() });
    const first = await reader.listDocuments({ limit: 1 });
    expect(first).toEqual({
      documents: [expect.objectContaining({ path: "/proc/context/10_user_memory/01_личная_конституция.md" })],
      nextCursor: "/proc/context/10_user_memory/01_личная_конституция.md",
      truncated: true,
    });
    const second = await reader.listDocuments({ cursor: first.nextCursor!, limit: 1 });
    expect(second.documents.map(({ path }) => path)).toEqual(["/proc/context/90_agent_memory/soul.md"]);
    expect(second).toMatchObject({ nextCursor: null, truncated: false });
    expect(JSON.stringify([first, second])).not.toContain("owner/context");
    expect(JSON.stringify([first, second])).not.toContain("private.md");
  });

  it("lists stable UTF-8 byte sizes without reading document bodies", async () => {
    const store = await fixture();
    await store.put("owner", "context/размер🙂.md", "Привет🙂");
    let bodyReads = 0;
    const metadataOnlyStore: DocumentStore = {
      ...store,
      async get(userId, path) {
        bodyReads += 1;
        return store.get(userId, path);
      },
      async getExact(userId, path) {
        bodyReads += 1;
        return store.getExact(userId, path);
      },
      async list(userId, prefix) {
        bodyReads += 1;
        return store.list(userId, prefix);
      },
      async listExact(userId, prefix) {
        bodyReads += 1;
        return store.listExact(userId, prefix);
      },
    };
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: metadataOnlyStore });

    const result = await reader.listDocuments({ prefix: "/proc/context", limit: 10 });

    expect(bodyReads).toBe(0);
    expect(result.documents.find(({ path }) => path === "/proc/context/размер🙂.md")).toMatchObject({
      size: Buffer.byteLength("Привет🙂", "utf8"),
    });
  });

  it("paginates paths by stable code-unit order without collapsing Unicode equivalents", async () => {
    const store = createInMemoryDocumentStore(clock);
    await store.put("owner", "context/café.md", "NFC");
    await store.put("owner", "context/café.md", "NFD");
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store });

    const first = await reader.listDocuments({ limit: 1 });
    const second = await reader.listDocuments({ cursor: first.nextCursor!, limit: 1 });

    expect(first.documents.map(({ path }) => path)).toEqual(["/proc/context/café.md"]);
    expect(second.documents.map(({ path }) => path)).toEqual(["/proc/context/café.md"]);
    expect(second).toMatchObject({ nextCursor: null, truncated: false });
  });

  it("lists one canonical metadata entry for a legacy alias and supports an empty prefix", async () => {
    const store = createInMemoryDocumentStore(clock, [
      { userId: "owner", path: "context/imported-knowledge-base/legacy.md", content: "legacy🙂" },
      { userId: "owner", path: "context/legacy.md", content: "canonical" },
      { userId: "owner", path: "context/imported-knowledge-base/only-legacy.md", content: "старое" },
    ]);
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store });

    const result = await reader.listDocuments({ prefix: "", limit: 10 });

    expect(result.documents.map(({ path }) => path)).toEqual([
      "/proc/context/legacy.md",
      "/proc/context/only-legacy.md",
    ]);
    expect(result.documents.find(({ path }) => path === "/proc/context/legacy.md")?.size).toBe(Buffer.byteLength("canonical", "utf8"));
    expect(result.documents.find(({ path }) => path === "/proc/context/only-legacy.md")?.size).toBe(Buffer.byteLength("старое", "utf8"));
  });

  it("opens an imported personal constitution even when it was not auto-injected", async () => {
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: await fixture() });
    const result = await reader.readDocument({
      path: "/proc/context/10_user_memory/01_личная_конституция.md",
      section: "Принципы",
      maxCharacters: 100,
    });
    expect(result).toMatchObject({ found: true, sectionFound: true, truncated: false });
    expect(result.content).toContain("Сначала ясность, затем скорость.");
    expect(result.content).not.toContain("Беречь утренний фокус");
  });

  it("ignores Markdown headings inside fenced code blocks", async () => {
    const store = await fixture();
    await store.put("owner", "context/fenced.md", [
      "# Target",
      "before fence",
      "```markdown",
      "# Fake boundary",
      "```",
      "after fence",
      "## Child",
      "child content",
      "# Real boundary",
      "outside target",
    ].join("\n"));
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store });

    const result = await reader.readDocument({ path: "/proc/context/fenced.md", section: "Target", maxCharacters: 500 });

    expect(result.content).toContain("# Fake boundary");
    expect(result.content).toContain("after fence");
    expect(result.content).toContain("child content");
    expect(result.content).not.toContain("outside target");
  });

  it("does not select a Markdown heading that exists only inside a fenced code block", async () => {
    const store = await fixture();
    await store.put("owner", "context/fenced-only.md", "```md\n# Hidden\n```\n# Visible\ncontent");
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store });

    await expect(reader.readDocument({ path: "/proc/context/fenced-only.md", section: "Hidden" })).resolves.toMatchObject({ found: true, sectionFound: false });
  });

  it("bounds large reads with character offsets and explicit truncation", async () => {
    const store = await fixture();
    await store.put("owner", "context/large.md", "🙂".repeat(documentReadLimits.readMaximumCharacters + 10));
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store });
    const first = await reader.readDocument({ path: "/proc/context/large.md", maxCharacters: documentReadLimits.readMaximumCharacters });
    expect(Array.from(first.content)).toHaveLength(documentReadLimits.readMaximumCharacters);
    expect(first).toMatchObject({ offset: 0, nextOffset: documentReadLimits.readMaximumCharacters, truncated: true });
    const second = await reader.readDocument({ path: "/proc/context/large.md", offset: first.nextOffset!, maxCharacters: 20 });
    expect(Array.from(second.content)).toHaveLength(10);
    expect(second).toMatchObject({ nextOffset: null, truncated: false });
  });

  it("reads a 20k document page by page through truncated=false with visible totalCharacters", async () => {
    const store = createInMemoryDocumentStore(clock);
    await store.put("owner", "context/complete.md", "🙂".repeat(20_000));
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store });
    let offset = 0;
    let collected = "";
    for (;;) {
      const page = await reader.readDocument({ path: "/proc/context/complete.md", offset, maxCharacters: 8_000 });
      expect(page.totalCharacters).toBe(20_000);
      collected += page.content;
      if (!page.truncated) break;
      offset = page.nextOffset!;
    }
    expect(Array.from(collected)).toHaveLength(20_000);
  });

  it("clamps Unicode reads at the remaining turn budget and returns a typed exhaustion marker", async () => {
    const store = createInMemoryDocumentStore(clock);
    await store.put("owner", "context/big.md", "🙂".repeat(20));
    const contextBudget = createContextBudgetConfig({ documentTools: { turnReadCharacters: 7, readDefaultCharacters: 5, readMaximumCharacters: 10 } });
    const events: unknown[] = [];
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store, contextBudget, audit: async (event) => { events.push(event); } });

    const first = await reader.readDocument({ path: "/proc/context/big.md", maxCharacters: 5 });
    const boundary = await reader.readDocument({ path: "/proc/context/big.md", offset: first.nextOffset!, maxCharacters: 5 });
    const exhausted = await reader.readDocument({ path: "/proc/context/big.md", offset: boundary.nextOffset!, maxCharacters: 5 });

    expect(Array.from(first.content)).toHaveLength(5);
    expect(boundary).toMatchObject({ content: "🙂🙂", totalCharacters: 20, nextOffset: 7, truncated: true, readBudgetExhausted: true });
    expect(exhausted).toMatchObject({ content: "", totalCharacters: 20, nextOffset: 7, truncated: true, readBudgetExhausted: true });
    expect(exhausted.hint).toMatch(/section or search/);
    expect(events).toContainEqual(expect.objectContaining({ operation: "read", path: "/proc/context/big.md", returnedCharacters: 2, reason: "budget_exhausted" }));
  });

  it("does not read a body after the output budget is exhausted", async () => {
    const store = createInMemoryDocumentStore(clock);
    await store.put("owner", "context/big.md", "needle".repeat(20));
    let bodyReads = 0;
    const instrumented: DocumentStore = {
      ...store,
      async get(userId, path) {
        bodyReads += 1;
        return store.get(userId, path);
      },
    };
    const contextBudget = createContextBudgetConfig({ documentTools: { turnReadCharacters: 3 } });
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: instrumented, contextBudget });

    await reader.readDocument({ path: "/proc/context/big.md", maxCharacters: 3 });
    const exhausted = await reader.readDocument({ path: "/proc/context/big.md", offset: 3, maxCharacters: 3 });

    expect(bodyReads).toBe(1);
    expect(exhausted).toMatchObject({ found: true, content: "", readBudgetExhausted: true, scanBudgetExhausted: false });
  });

  it("reserves physical bytes before reads and reports scan exhaustion without reading a body", async () => {
    const store = createInMemoryDocumentStore(clock);
    await store.put("owner", "context/01.md", "12345");
    await store.put("owner", "context/02.md", "67890");
    let bodyReads = 0;
    let readBytes = 0;
    const instrumented: DocumentStore = {
      ...store,
      async get(userId, path) {
        bodyReads += 1;
        const document = await store.get(userId, path);
        readBytes += document === null ? 0 : Buffer.byteLength(document.content, "utf8");
        return document;
      },
    };
    const contextBudget = createContextBudgetConfig({ documentTools: { turnScanBytes: 5, maximumDocumentBytes: 5 } });
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: instrumented, contextBudget });

    await reader.readDocument({ path: "/proc/context/01.md" });
    const blocked = await reader.readDocument({ path: "/proc/context/02.md" });

    expect(bodyReads).toBe(1);
    expect(readBytes).toBe(5);
    expect(blocked).toMatchObject({ found: true, content: "", scanBudgetExhausted: true, documentTooLarge: false });
  });

  it("keeps legacy oversized documents visible but never materializes their bodies", async () => {
    const store = createInMemoryDocumentStore(clock, [
      { userId: "owner", path: "context/legacy-large.md", content: "x".repeat(6) },
    ]);
    let bodyReads = 0;
    const instrumented: DocumentStore = {
      ...store,
      async get(userId, path) {
        bodyReads += 1;
        return store.get(userId, path);
      },
    };
    const contextBudget = createContextBudgetConfig({ documentTools: { maximumDocumentBytes: 5, turnScanBytes: 10 } });
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: instrumented, contextBudget });

    const listed = await reader.listDocuments();
    const read = await reader.readDocument({ path: "/proc/context/legacy-large.md" });
    const search = await reader.searchDocuments({ query: "xx" });

    expect(listed.documents).toEqual([expect.objectContaining({ path: "/proc/context/legacy-large.md", size: 6 })]);
    expect(bodyReads).toBe(0);
    expect(read).toMatchObject({ found: true, content: "", documentTooLarge: true });
    expect(search).toMatchObject({ matches: [], truncated: true, documentTooLarge: true });
  });

  it("stops search before exceeding the physical scan budget", async () => {
    const store = createInMemoryDocumentStore(clock);
    await store.put("owner", "context/01.md", "no hit");
    await store.put("owner", "context/02.md", "needle");
    let bodyReads = 0;
    let readBytes = 0;
    const instrumented: DocumentStore = {
      ...store,
      async get(userId, path) {
        bodyReads += 1;
        const document = await store.get(userId, path);
        readBytes += document === null ? 0 : Buffer.byteLength(document.content, "utf8");
        return document;
      },
    };
    const contextBudget = createContextBudgetConfig({ documentTools: { maximumDocumentBytes: 10, turnScanBytes: 6 } });
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: instrumented, contextBudget });

    const search = await reader.searchDocuments({ query: "needle" });

    expect(bodyReads).toBe(1);
    expect(readBytes).toBe(6);
    expect(search).toMatchObject({ matches: [], truncated: true, scanBudgetExhausted: true });
  });

  it("counts search snippets in the shared budget while metadata listing remains free", async () => {
    const store = createInMemoryDocumentStore(clock);
    await store.put("owner", "context/01.md", "needle-abcdef");
    await store.put("owner", "context/02.md", "needle-ghijkl");
    const contextBudget = createContextBudgetConfig({ documentTools: { turnReadCharacters: 6, searchSnippetCharacters: 4 } });
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store, contextBudget });

    await reader.listDocuments({ limit: 10 });
    await reader.listDocuments({ limit: 10 });
    const search = await reader.searchDocuments({ query: "needle", limit: 2 });
    const read = await reader.readDocument({ path: "/proc/context/01.md", maxCharacters: 4 });

    expect(search.matches).toHaveLength(2);
    expect(search.matches.map(({ snippet }) => Array.from(snippet).length)).toEqual([5, 1]);
    expect(search.matches.map(({ snippet }) => snippet)).toEqual(["need…", "…"]);
    expect(search).toMatchObject({ truncated: true, readBudgetExhausted: true });
    expect(read).toMatchObject({ content: "", readBudgetExhausted: true });
  });

  it("searches only the bound owner and returns bounded snippets", async () => {
    const store = await fixture();
    await store.put("owner", "context/search.md", `${"a".repeat(400)}needle${"b".repeat(400)}`);
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store });
    const result = await reader.searchDocuments({ query: "needle", limit: 1 });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ path: "/proc/context/search.md" });
    expect(result.matches[0]!.snippet).toContain("needle");
    expect(Array.from(result.matches[0]!.snippet)).toHaveLength(documentReadLimits.searchSnippetCharacters + 2);
    expect(JSON.stringify(result)).not.toContain("чужой секрет");
  });

  it("stops lazy search before reading beyond the requested result limit", async () => {
    const store = createInMemoryDocumentStore(clock);
    await store.put("owner", "context/01-first.md", "needle один");
    await store.put("owner", "context/02-second.md", "needle два");
    await store.put("owner", "context/03-tail.md", "tail must not be read");
    let bodyReads = 0;
    const lazyStore: DocumentStore = {
      ...store,
      async get(userId, path) {
        bodyReads += 1;
        return store.get(userId, path);
      },
    };
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: lazyStore });

    const result = await reader.searchDocuments({ query: "needle", limit: 1 });

    expect(result).toEqual({
      matches: [expect.objectContaining({ path: "/proc/context/01-first.md" })],
      truncated: true,
      readBudgetExhausted: false,
      scanBudgetExhausted: false,
      documentTooLarge: false,
      hint: null,
    });
    expect(bodyReads).toBe(1);
  });

  it("matches Unicode literal substrings in paths without requiring content matches", async () => {
    const store = createInMemoryDocumentStore(clock);
    await store.put("owner", "context/Проект-ЖАР🙂.md", "body without query");
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store });

    const result = await reader.searchDocuments({ query: "жар🙂", limit: 1 });

    expect(result).toMatchObject({
      matches: [{ path: "/proc/context/Проект-ЖАР🙂.md", snippet: "body without query" }],
      truncated: false,
    });
  });

  it("keeps case-insensitive snippets aligned when lowercase expands a character", async () => {
    const store = await fixture();
    await store.put("owner", "context/expanding-lowercase.md", `${"İ".repeat(400)}needle${"b".repeat(400)}`);
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store });

    const result = await reader.searchDocuments({ query: "NEEDLE", limit: 1 });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]!.snippet).toContain("needle");
    expect(Array.from(result.matches[0]!.snippet)).toHaveLength(documentReadLimits.searchSnippetCharacters + 2);
  });

  it("returns emoji snippets through Mastra output validation", async () => {
    const store = await fixture();
    await store.put("owner", "context/emoji-search.md", `${"🙂".repeat(400)}needle${"🚀".repeat(400)}`);
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store });
    const searchTool = createDocumentTools(reader).searchDocuments;
    const result = await searchTool.execute?.({ query: "needle", limit: 1 }, {} as never);

    expect(result).toMatchObject({
      matches: [{ path: "/proc/context/emoji-search.md" }],
      truncated: false,
    });
    expect(result).not.toMatchObject({ error: true });
    if (result && "matches" in result) {
      expect(result.matches[0]!.snippet).toContain("needle");
      expect(Array.from(result.matches[0]!.snippet)).toHaveLength(documentReadLimits.searchSnippetCharacters + 2);
      expect(result.matches[0]!.snippet.length).toBeGreaterThan(documentReadLimits.searchSnippetCharacters + 2);
    }
  });

  it("validates Mastra search output against the configured environment snippet limit", async () => {
    const store = await fixture();
    const configuredSnippetCharacters = 1_000;
    await store.put("owner", "context/configured-search.md", `${"🙂".repeat(700)}needle${"🚀".repeat(700)}`);
    const contextBudget = contextBudgetConfigFromEnv({
      ASSISTANT_DOCUMENT_SEARCH_SNIPPET_CHARACTERS: String(configuredSnippetCharacters),
    });
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: store, contextBudget });
    const result = await createDocumentTools(reader).searchDocuments.execute?.({ query: "needle", limit: 1 }, {} as never);

    expect(result).not.toMatchObject({ error: true });
    if (result && "matches" in result) {
      expect(result.matches[0]!.snippet).toContain("needle");
      expect(Array.from(result.matches[0]!.snippet)).toHaveLength(configuredSnippetCharacters + 2);
    }
  });

  it("uses configured list, read, and search maxima in Mastra input schemas", async () => {
    const store = await fixture();
    const contextBudget = contextBudgetConfigFromEnv({
      ASSISTANT_DOCUMENT_LIST_MAXIMUM: "51",
      ASSISTANT_DOCUMENT_READ_MAXIMUM_CHARACTERS: "8001",
      ASSISTANT_DOCUMENT_SEARCH_MAXIMUM: "21",
    });
    const tools = createDocumentTools(createOwnerDocumentReader({ userId: "owner", documentStore: store, contextBudget }));

    await expect(tools.listDocuments.execute?.({ limit: 51 }, {} as never)).resolves.toMatchObject({ truncated: false });
    await expect(tools.readDocument.execute?.({
      path: "/proc/context/90_agent_memory/soul.md",
      maxCharacters: 8_001,
    }, {} as never)).resolves.toMatchObject({ found: true });
    await expect(tools.searchDocuments.execute?.({ query: "Тон", limit: 21 }, {} as never)).resolves.toMatchObject({
      matches: [{ path: "/proc/context/90_agent_memory/soul.md" }],
    });
  });

  it("rejects traversal and alternate namespaces, isolates owners, and handles missing files", async () => {
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: await fixture() });
    await expect(reader.readDocument({ path: "/proc/context/../other/private.md" })).rejects.toThrow("invalid vault path");
    await expect(reader.readDocument({ path: "/proc/profile" })).rejects.toThrow("must start with /proc/context/");
    await expect(reader.listDocuments({ cursor: "/proc/context/../../private.md" })).rejects.toThrow("invalid vault path");
    await expect(reader.readDocument({ path: "/proc/context/10_user_memory/private.md" })).resolves.toMatchObject({ found: false, content: "", truncated: false });
  });

  it("audits logical paths and read progress without query or document text", async () => {
    const events: unknown[] = [];
    const reader = createOwnerDocumentReader({
      userId: "owner",
      documentStore: await fixture(),
      audit: async (event) => { events.push(event); },
    });
    await reader.searchDocuments({ query: "ясность" });
    await reader.readDocument({ path: "/proc/context/missing.md" });
    expect(events).toEqual([
      {
        operation: "search", resultCount: 1, truncated: false, outcome: "ok",
        path: "/proc/context/10_user_memory/01_личная_конституция.md",
        totalCharacters: 98, returnedCharacters: 98, nextOffset: 98, reason: "ok",
      },
      {
        operation: "read", resultCount: 0, truncated: false, outcome: "not_found",
        path: "/proc/context/missing.md", totalCharacters: 0, returnedCharacters: 0, nextOffset: 0, reason: "ok",
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ясность|Сначала ясность|content|query/);
  });

  it("keeps registry, manifests, README, and wired TypeScript toolset aligned", async () => {
    const registry = JSON.parse(readFileSync("vault/assistant/bin/registry.json", "utf8")) as { personalAssistant: Array<{ id: string; manifest: string }> };
    const registeredIds = registry.personalAssistant.map(({ id }) => id);
    expect(registeredIds).toEqual(["captureIdea", ...assistantDocumentToolNames]);
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: await fixture() });
    expect(Object.keys(createDocumentTools(reader))).toEqual([...assistantDocumentToolNames]);
    const readme = readFileSync("vault/assistant/bin/README.md", "utf8");
    for (const entry of registry.personalAssistant) {
      expect(readme).toContain(`\`${entry.id}\``);
      expect(readFileSync(`vault/assistant/bin/${entry.manifest}`, "utf8")).toContain("## Purpose");
    }
  });
});
