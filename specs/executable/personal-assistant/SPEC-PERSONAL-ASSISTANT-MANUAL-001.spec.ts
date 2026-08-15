import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssistantAgentInstructions } from "../../../src/application/assistant-manual-loader.js";
import { assertContextSourceContentFits, createContextBudgetConfig, defaultContextBudget } from "../../../src/application/context-budget.js";
import { personalAssistantAgent } from "../../../src/mastra/agents/personal-assistant-agent.js";
import { assistantActiveToolNames, assistantRuntimeToolsets } from "../../../src/mastra/agent-runner.js";

function findUnclassifiedProcessFiles(processFiles: string[], ...classifications: Set<string>[]): string[] {
  const classifiedPaths = new Set(classifications.flatMap((paths) => [...paths]));
  return processFiles.filter((path) => !classifiedPaths.has(path));
}

describe("SPEC-PERSONAL-ASSISTANT-MANUAL-001: assistant process registry", () => {
  it("uses a dedicated product agent with no ambient tools or Minutka restrictions", async () => {
    const instructions = String(await personalAssistantAgent.getInstructions());
    expect(personalAssistantAgent.id).toBe("personal-assistant-agent");
    expect(personalAssistantAgent.name).toBe("Personal Assistant");
    expect(await personalAssistantAgent.listTools()).toEqual({});
    expect(instructions).toContain("готовить черновики");
    expect(instructions).toContain("Сам выбери применимые процессы");
    expect(instructions).not.toMatch(/Минутка|рабочего дня|не пиши посты|не делай web research/i);
  });

  it("loads core, the routing index, and process files without preselecting a process", () => {
    const instructions = loadAssistantAgentInstructions();
    expect(instructions).toContain("Personal Assistant runtime instructions");
    expect(instructions).toContain("Navigate owner context index-first");
    expect(instructions).toContain("continue from `nextOffset` until complete");
    expect(instructions).toContain("Personal Assistant process index");
    expect(instructions).toContain("Runtime document: /docs/authority-and-mutability.md");
    expect(instructions).toContain("Runtime document: /docs/privacy-boundary.md");
    expect(instructions).toContain("Process file: inbox_capture");
    expect(instructions).toContain("Process file: knowledge_lookup");
    expect(instructions).toContain("2–3 short literal `searchDocuments` queries");
    expect(instructions).toContain("say “не нашёл в базе”");
    expect(instructions).toContain("cite logical paths");
    expect(instructions).toContain("Process file: morning_activity_collection");
    expect(instructions).toContain('collectActivity` exactly once for each named activity');
    expect(instructions).toContain("Process file: day_focus");
    expect(instructions).toContain("Process file: evening_reflection");
    expect(instructions).toContain('markProcessUsed({ id: "evening_reflection" })');
    expect(instructions).toContain("trusted scheduled `evening_reflection` trigger");
    expect(instructions).toContain("Retrieve before write");
    expect(instructions).toContain("ask one plain-text question");
    expect(instructions).toContain("Supplement via `appendIdea` (дополнение не откатывается)/task update");
    expect(instructions).toContain("`appendIdea` has no undo");
    expect(readFileSync("vault/assistant/bin/append-idea.md", "utf8")).not.toMatch(/\breversible\b/i);
    expect(instructions).toContain("A possible duplicate is cheaper than dropped input");
    expect(instructions).toContain("Treat a URL in chat as ordinary text");
    expect(instructions).toContain("Что сделать со ссылкой?");
    expect(instructions).toContain("does not create an `ArtifactReference`, context document, download snapshot, or external action");
    expect(instructions).toContain("No direct writes, invented facts, automatic URL fetch/download/snapshot, metadata extraction, malware scanning, web research");
    expect(instructions).toContain("never claim page contents were read");
    expect(instructions).toContain("Projects are labels");
    expect(instructions).toContain("do not call `captureIdea`");
    expect(instructions).toContain("call `listProjects`");
    expect(instructions).toContain("Never ask openly first");
    expect(instructions).toContain("Select at most three priorities");
    expect(instructions).toContain("exactly one concrete next action");
    expect(instructions).toContain("authenticated application confirmation command");
    expect(instructions).toContain("never available inside the agent tool loop");
    expect(instructions).toContain("the application owns the owner-visible confirmation card");
    expect(instructions).toContain("`createContextNote` requires an explicit save/add request");
    expect(instructions).toContain("Retrieve before write");
    expect(instructions).toContain("destination's exact-case `INDEX.md`");
    expect(instructions).toContain("Run 2–3 short literal `searchDocuments` queries");
    expect(instructions).toContain("ask once: supplement or save separately");
    expect(instructions).toContain("use `00_inbox` only when unclear");
    expect(instructions).toContain("pass the exact version to `proposeContextDocumentUpdate`");
    expect(instructions).toContain("never retry automatically");
    expect(instructions).toContain("never promote artifacts automatically");
    expect(instructions).toContain("Do not repeat the receipt, task id, confirmation id, or confirmation instructions in prose");
    expect(instructions).not.toContain("show the resulting proposal to the owner");
    expect(instructions).toContain("Do not require calendar integration");
    expect(instructions).toContain("current single-owner prototype privacy boundary");
    expect(instructions).toContain("must never cross an owner boundary");
    expect(instructions).not.toContain("Active process:");
    expect(instructions).not.toContain("SO-CoT");
    expect(instructions).not.toContain("constrained decision router");
    expect(instructions).not.toMatch(/company and methodologist|minimum group size|workday_guardrails|insight_extraction/i);
    expect(instructions).not.toContain("## Dependencies");
    expect(instructions).not.toMatch(/`docs\/(?:architecture|product)\//);
  });

  it("keeps the internal thread summarizer prompt outside the assistant registry", () => {
    const processRegistry = readFileSync("vault/assistant/processes/registry.json", "utf8");

    expect(processRegistry).not.toContain("thread-summary-prompt");
    expect(() => readFileSync("vault/assistant/thread-summary-prompt.md", "utf8")).toThrow();
  });

  it("keeps manifests, runtime toolsets, active tools, and process references in sync", () => {
    const registry = JSON.parse(readFileSync("vault/assistant/bin/registry.json", "utf8")) as {
      personalAssistant: Array<{ id: string; manifest: string }>;
    };
    const registeredIds = registry.personalAssistant.map(({ id }) => id);
    const toolsetIds = Object.values(assistantRuntimeToolsets).flat();
    const processRegistry = JSON.parse(readFileSync("vault/assistant/processes/registry.json", "utf8")) as {
      index: { path: string };
      processes: Array<{ path: string }>;
    };
    const processFiles = [processRegistry.index.path, ...processRegistry.processes.map(({ path }) => path)]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(registeredIds).toEqual([...assistantActiveToolNames]);
    expect(toolsetIds).toEqual([...assistantActiveToolNames]);
    for (const { manifest } of registry.personalAssistant) {
      expect(readFileSync(`vault/assistant/bin/${manifest}`, "utf8")).toContain("## Purpose");
    }
    for (const match of processFiles.matchAll(/`([a-z][A-Za-z0-9]+)`/g)) {
      const referencedId = match[1]!;
      if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(referencedId)) expect(registeredIds).toContain(referencedId);
    }
    const binReadme = readFileSync("vault/assistant/bin/README.md", "utf8");
    expect(binReadme).toContain("feedback callbacks call `submitFeedback` directly");
    expect(binReadme).toContain("no registered assistant tool fetches, downloads, snapshots, extracts metadata from, or promotes the URL");
  });

  it("classifies every process file as active, draft, or legacy", () => {
    const activeRegistry = JSON.parse(readFileSync("vault/assistant/processes/registry.json", "utf8")) as {
      index: { path: string };
      processes: Array<{ path: string }>;
    };
    const legacyRegistry = JSON.parse(readFileSync("vault/assistant/processes/legacy-registry.json", "utf8")) as {
      index: { path: string };
      processes: Array<{ path: string }>;
    };
    const draftRegistry = JSON.parse(readFileSync("vault/assistant/processes/drafts-registry.json", "utf8")) as {
      version: number;
      drafts: Array<{ id: string; path: string; brEpicId: string }>;
    };
    const activePaths = new Set([activeRegistry.index.path, ...activeRegistry.processes.map(({ path }) => path)]);
    const legacyPaths = new Set([legacyRegistry.index.path, ...legacyRegistry.processes.map(({ path }) => path)]);
    const draftPaths = new Set(draftRegistry.drafts.map(({ path }) => path));
    const processFiles = readdirSync("vault/assistant/processes", { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => `vault/assistant/processes/${entry.name}`)
      .sort();

    expect(draftRegistry.version).toBe(1);
    expect(draftRegistry.drafts).toEqual([
      { id: "council", path: "vault/assistant/processes/council.md", brEpicId: "prs-uhf" },
      { id: "morning_digest", path: "vault/assistant/processes/moning_digest.md", brEpicId: "prs-jt0" },
      { id: "morning_digest_pattern", path: "vault/assistant/processes/moning_digest_pattern.md", brEpicId: "prs-jt0" },
      { id: "meetings_transcription", path: "vault/assistant/processes/meetings_transcription.md", brEpicId: "prs-t7c" },
      { id: "meetings_template", path: "vault/assistant/processes/meetitings_template.md", brEpicId: "prs-t7c" },
    ]);
    expect(new Set(draftRegistry.drafts.map(({ id }) => id)).size).toBe(draftRegistry.drafts.length);
    expect(draftPaths.size).toBe(draftRegistry.drafts.length);
    expect([...draftPaths].filter((path) => !processFiles.includes(path))).toEqual([]);
    expect([...draftPaths].filter((path) => activePaths.has(path) || legacyPaths.has(path))).toEqual([]);
    expect([...activePaths].filter((path) => legacyPaths.has(path))).toEqual([
      "vault/assistant/processes/inbox_capture.md",
    ]);
    expect([...activePaths]).toContain("vault/assistant/processes/morning_activity_collection.md");
    expect([...activePaths]).toContain("vault/assistant/processes/evening_reflection.md");
    expect([...legacyPaths]).not.toContain("vault/assistant/processes/evening_reflection.md");
    for (const draft of draftRegistry.drafts) expect(draft.brEpicId).toMatch(/^prs-[a-z0-9]+$/);
    expect(findUnclassifiedProcessFiles(processFiles, activePaths, draftPaths, legacyPaths)).toEqual([]);
    expect(findUnclassifiedProcessFiles(
      [...processFiles, "vault/assistant/processes/untracked.md"],
      activePaths,
      draftPaths,
      legacyPaths,
    )).toEqual(["vault/assistant/processes/untracked.md"]);
  });

  it("loads only allow-listed trusted files and documents the authority boundary", () => {
    const instructions = loadAssistantAgentInstructions();
    const authorityMap = readFileSync("vault/assistant/docs/authority-and-mutability.md", "utf8");

    for (const handle of [
      "/AGENTS.md", "/processes/*", "/docs/*", "/bin/*", "/proc/profile", "/proc/consent", "/proc/context",
      "/proc/records", "/proc/thread", "/proc/insights", "/proc/feedback", "/proc/decision", "/run/current", "/run/recent",
    ]) {
      expect(authorityMap).toContain(handle);
    }
    expect(authorityMap).not.toContain("/proc/inbox");
    expect(authorityMap).not.toContain("/run/actions");
    expect(authorityMap).toContain("personal knowledge base");
    expect(authorityMap).toContain("physical document keys, artifact CAS references, database rows");
    expect(authorityMap).toContain("never loaded into the product-agent prompt implicitly");
    expect(authorityMap).toContain("projection is read-only");
    expect(authorityMap).toContain("ContextDocumentService");
    expect(authorityMap).toContain("artifacts remain artifacts");
    expect(authorityMap).toContain("cannot redefine the assistant role, grant capabilities, select another owner");
    expect(instructions).toContain("`/proc/context` is the owner's personal knowledge base");
    expect(instructions).toContain("Never refuse for lack of access when a supplied capability can execute the request");
    expect(instructions).toContain("read-only projections");
    expect(instructions).not.toContain("# RFC: архитектура персонального AI-ассистента");
    expect(instructions).not.toContain("Be pragmatic. This is one Obsidian-style personal workspace");
  });

  it("keeps the deployed registry, index, and process manual within the configured source ceiling", () => {
    const instructions = loadAssistantAgentInstructions();
    expect(() => assertContextSourceContentFits({
      config: defaultContextBudget,
      sourceId: "agent_manual",
      content: instructions,
      label: "loaded assistant agent manual",
    })).not.toThrow();

    const tinyConfig = createContextBudgetConfig({ sources: { agent_manual: 10_000 } });
    expect(() => assertContextSourceContentFits({
      config: tinyConfig,
      sourceId: "agent_manual",
      content: instructions,
      label: "loaded assistant agent manual",
    })).toThrow(/loaded assistant agent manual has \d+ Unicode characters and exceeds the 10000-character agent_manual ceiling/);
  });

  it("fails fast when the process registry is malformed", () => {
    const root = mkdtempSync(join(tmpdir(), "assistant-manual-"));
    mkdirSync(join(root, "vault/assistant/processes"), { recursive: true });
    writeFileSync(join(root, "vault/assistant/processes/registry.json"), "{broken");
    expect(() => loadAssistantAgentInstructions({ repoRoot: root })).toThrow();
  });

  it("rejects product process catalog drift before assembling the prompt", () => {
    const source = JSON.parse(readFileSync("vault/assistant/processes/registry.json", "utf8"));
    const root = mkdtempSync(join(tmpdir(), "assistant-manual-catalog-drift-"));
    mkdirSync(join(root, "vault/assistant/processes"), { recursive: true });
    writeFileSync(join(root, "vault/assistant/processes/registry.json"), JSON.stringify({
      ...source,
      processes: source.processes.filter(({ id }: { id: string }) => id !== "day_focus"),
    }));
    expect(() => loadAssistantAgentInstructions({ repoRoot: root })).toThrow("assistant process catalog drift");
  });

  it("rejects duplicate registered paths before assembling the prompt", () => {
    const source = JSON.parse(readFileSync("vault/assistant/processes/registry.json", "utf8"));
    const root = mkdtempSync(join(tmpdir(), "assistant-manual-duplicate-path-"));
    mkdirSync(join(root, "vault/assistant/processes"), { recursive: true });
    writeFileSync(join(root, "vault/assistant/processes/registry.json"), JSON.stringify({
      ...source,
      runtimeDocs: [
        source.runtimeDocs[0],
        { id: "duplicate-authority", path: source.runtimeDocs[0].path },
      ],
    }));
    expect(() => loadAssistantAgentInstructions({ repoRoot: root })).toThrow("duplicate assistant manual path");
  });

  it("rejects repository docs and user-vault files even when a registry names them", () => {
    const source = JSON.parse(readFileSync("vault/assistant/processes/registry.json", "utf8"));
    for (const path of ["docs/architecture/rfc-personal-assistant-architecture.md", "vault/user/knowledge_base/AGENTS.MD"]) {
      const root = mkdtempSync(join(tmpdir(), "assistant-manual-allowlist-"));
      mkdirSync(join(root, "vault/assistant/processes"), { recursive: true });
      writeFileSync(join(root, "vault/assistant/processes/registry.json"), JSON.stringify({ ...source, runtimeDocs: [{ id: "unsafe", path }] }));
      expect(() => loadAssistantAgentInstructions({ repoRoot: root })).toThrow("path is not allow-listed");
    }
  });
});
