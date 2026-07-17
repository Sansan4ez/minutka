import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createOwnerDocumentReader, documentReadLimits } from "../../../src/application/document-reader.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
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

  it("rejects traversal and alternate namespaces, isolates owners, and handles missing files", async () => {
    const reader = createOwnerDocumentReader({ userId: "owner", documentStore: await fixture() });
    await expect(reader.readDocument({ path: "/proc/context/../other/private.md" })).rejects.toThrow("invalid vault path");
    await expect(reader.readDocument({ path: "/proc/profile" })).rejects.toThrow("must start with /proc/context/");
    await expect(reader.listDocuments({ cursor: "/proc/context/../../private.md" })).rejects.toThrow("invalid vault path");
    await expect(reader.readDocument({ path: "/proc/context/10_user_memory/private.md" })).resolves.toMatchObject({ found: false, content: "", truncated: false });
  });

  it("audits usage without query, path, or content", async () => {
    const events: unknown[] = [];
    const reader = createOwnerDocumentReader({
      userId: "owner",
      documentStore: await fixture(),
      audit: async (event) => { events.push(event); },
    });
    await reader.searchDocuments({ query: "ясность" });
    await reader.readDocument({ path: "/proc/context/missing.md" });
    expect(events).toEqual([
      { operation: "search", resultCount: 1, truncated: false, outcome: "ok" },
      { operation: "read", resultCount: 0, truncated: false, outcome: "not_found" },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ясность|missing|content|path/);
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
