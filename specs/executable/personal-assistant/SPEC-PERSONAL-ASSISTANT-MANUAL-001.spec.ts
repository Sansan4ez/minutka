import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssistantAgentInstructions } from "../../../src/application/assistant-manual-loader.js";
import { assertContextSourceContentFits, createContextBudgetConfig, defaultContextBudget } from "../../../src/application/context-budget.js";
import { personalAssistantAgent } from "../../../src/mastra/agents/personal-assistant-agent.js";
import { assistantActiveToolNames, assistantRuntimeToolsets } from "../../../src/mastra/agent-runner.js";
import { assistantDisabledProcessIds, assistantToolProcessOwners, isAssistantDisabledProcessId } from "../../../src/domain/assistant-process.js";

function findUnclassifiedProcessFiles(processFiles: string[], ...classifications: Set<string>[]): string[] {
  const classifiedPaths = new Set(classifications.flatMap((paths) => [...paths]));
  return processFiles.filter((path) => !classifiedPaths.has(path));
}

describe("SPEC-PERSONAL-ASSISTANT-MANUAL-001: assistant process registry", () => {
  it("uses a dedicated product agent with no ambient tools", async () => {
    const instructions = String(await personalAssistantAgent.getInstructions());
    expect(personalAssistantAgent.id).toBe("personal-assistant-agent");
    expect(personalAssistantAgent.name).toBe("Personal Assistant");
    expect(await personalAssistantAgent.listTools()).toEqual({});
    expect(instructions).toContain("Сам выбери применимые процессы");
  });

  it("loads the «Минутка» role, runtime docs, and exactly seven active processes", () => {
    const instructions = loadAssistantAgentInstructions();
    expect(instructions).toContain("«Минутка» runtime instructions");
    expect(instructions).toContain("helps an employee diagnose working routines");
    expect(instructions).toContain("«Минутка» process index");
    expect(instructions).toContain("Runtime document: /docs/authority-and-mutability.md");
    expect(instructions).toContain("Runtime document: /docs/privacy-boundary.md");
    expect(instructions).toContain("Process file: morning_planning");
    expect(instructions).toContain("Plans never become activities");
    expect(instructions).toContain("Process file: midday_adjustment");
    expect(instructions).toContain("chat-only and read-only");
    expect(instructions).toContain("In any applicable process at any time of day");
    expect(instructions).toContain("an array item for every named factual activity");
    expect(instructions).toContain("Plans, intentions, future tasks, and not-started work never go to `collectActivities`");
    expect(instructions).toContain("what else to add to what is already noted");
    expect(instructions).not.toMatch(/(?:up to|one to) three activities/i);
    expect(instructions).toContain("updatePersonalContext");
    expect(instructions).toContain("Do not ask a questionnaire");
    expect(instructions).toContain("Process file: personal_context_review");
    expect(instructions).toContain("observations stay separate");
    expect(instructions).toContain("Process file: consent_and_privacy");
    expect(instructions).toContain("full tenant-scoped research access");
    expect(instructions).toContain("company behind the client-report boundary");
    expect(instructions).toContain("manual company/group/subject deletion with report recompute");
    expect(instructions).toContain("Process file: evening_reflection");
    expect(instructions).toContain('markProcessUsed({ id: "evening_reflection" })');
    expect(instructions).toContain("Process file: weekly_summary");
    expect(instructions).toContain("readWeeklyActivities");
    expect(instructions).toContain("too thin for a pattern");
    expect(instructions).toContain("Process file: final_report");
    expect(instructions).toContain("readCycleActivities");
    expect(instructions).toContain("call a pattern only what the result confirms as repeated");
    expect(instructions).toContain("does not reach the methodologist or the company");
    expect(instructions).not.toMatch(/\b(?:inbox_capture|knowledge_lookup|day_focus)\b/);
    expect(instructions).toContain("In-the-moment help is limited to discussing how the employee uses working time and work-related emotional state");
    expect(instructions).toContain("ask a clarifying question or suggest an approach, structure, method, or simplification, including how to structure a report");
    expect(instructions).toContain("requests to prepare posts, letters, emails, reports, presentations, commercial proposals");
    expect(instructions).toContain("conduct internet research, or teach AI tools");
    expect(instructions).toContain("briefly and gently decline, then invite the employee back to their working day");
    expect(instructions).toContain("Do not moralize or evaluate the employee");
    expect(instructions).toContain("`support` is warmer and softer; `efficiency` is concise, structured, and practical");
    expect(instructions).not.toMatch(/may prepare|draft posts|draft letters|prepare research briefs|perform internet research/i);
    expect(instructions).toContain("могу перенести утреннее, вечернее или недельное сообщение на другое время");
    expect(instructions).toContain("never expose runtime vocabulary");
    expect(instructions).not.toContain("supported active check-ins");
    expect(instructions).not.toContain("For supported check-ins");
    expect(instructions).not.toContain("Process file: workday_guardrails");
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

    expect(registeredIds).toEqual([
      "listSchedules", "setDailySchedule", "disableSchedule", "collectActivities", "readWeeklyActivities",
      "readCycleActivities", "updatePersonalContext", "markProcessUsed",
    ]);
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
    expect(binReadme).toContain(
      "Deterministic transport/application actions required for onboarding, consent, reporting, feedback, and personal-data deletion are not agent tools.",
    );
    expect(binReadme).toContain(
      "A chat URL follows the capture path as ordinary text: no registered assistant tool fetches, downloads, snapshots, extracts metadata from, or promotes the URL.",
    );
  });

  it("keeps tools of disabled processes out of the agent toolset", () => {
    const disabledRegistry = JSON.parse(readFileSync("vault/assistant/processes/disabled-registry.json", "utf8")) as {
      disabled: Array<{ id: string }>;
    };
    const binRegistry = JSON.parse(readFileSync("vault/assistant/bin/registry.json", "utf8")) as {
      personalAssistant: Array<{ id: string }>;
      disabledForMinutka: Array<{ id: string; manifest: string; process: string }>;
    };
    const disabledToolNames = Object.entries(assistantToolProcessOwners)
      .filter(([, owner]) => owner !== undefined && isAssistantDisabledProcessId(owner))
      .map(([toolName]) => toolName);

    expect([...assistantDisabledProcessIds]).toEqual(disabledRegistry.disabled.map(({ id }) => id));
    expect(assistantActiveToolNames.filter((toolName) => disabledToolNames.includes(toolName))).toEqual([]);
    expect(assistantActiveToolNames).not.toContain("captureIdea");
    expect(assistantActiveToolNames).not.toContain("listTasks");
    expect(assistantActiveToolNames).not.toContain("listDocuments");
    expect(assistantActiveToolNames).not.toContain("createContextNote");
    expect(assistantActiveToolNames).toContain("collectActivities");
    expect(assistantActiveToolNames).toContain("readWeeklyActivities");
    expect(assistantActiveToolNames).toContain("readCycleActivities");
    expect(assistantActiveToolNames).toContain("updatePersonalContext");
    expect(binRegistry.disabledForMinutka.map(({ id }) => id).sort()).toEqual([...disabledToolNames].sort());
    expect(binRegistry.personalAssistant.some(({ id }) => disabledToolNames.includes(id))).toBe(false);
    for (const { manifest, process } of binRegistry.disabledForMinutka) {
      expect(readFileSync(`vault/assistant/bin/${manifest}`, "utf8")).toContain("## Purpose");
      expect([...assistantDisabledProcessIds]).toContain(process);
    }
  });

  it("classifies every process file as active, disabled, draft, or legacy", () => {
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
    const disabledRegistry = JSON.parse(readFileSync("vault/assistant/processes/disabled-registry.json", "utf8")) as {
      version: number;
      disabled: Array<{ id: string; path: string; reason: string }>;
    };
    const activePaths = new Set([activeRegistry.index.path, ...activeRegistry.processes.map(({ path }) => path)]);
    const legacyPaths = new Set([legacyRegistry.index.path, ...legacyRegistry.processes.map(({ path }) => path)]);
    const draftPaths = new Set(draftRegistry.drafts.map(({ path }) => path));
    const disabledPaths = new Set(disabledRegistry.disabled.map(({ path }) => path));
    const processFiles = readdirSync("vault/assistant/processes", { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => `vault/assistant/processes/${entry.name}`)
      .sort();

    expect(activeRegistry.processes.map(({ path }) => path)).toEqual([
      "vault/assistant/processes/morning_planning.md",
      "vault/assistant/processes/midday_adjustment.md",
      "vault/assistant/processes/personal_context_review.md",
      "vault/assistant/processes/consent_and_privacy.md",
      "vault/assistant/processes/evening_reflection.md",
      "vault/assistant/processes/weekly_summary.md",
      "vault/assistant/processes/final_report.md",
    ]);
    expect(disabledRegistry).toEqual({
      version: 1,
      disabled: [
        { id: "inbox_capture", path: "vault/assistant/processes/inbox_capture.md", reason: "Outside the first-version «Минутка» product boundary" },
        { id: "knowledge_lookup", path: "vault/assistant/processes/knowledge_lookup.md", reason: "Outside the first-version «Минутка» product boundary" },
        { id: "morning_activity_collection", path: "vault/assistant/processes/morning_activity_collection.md", reason: "Retired from the active daily rhythm; factual collection moved to evening reflection with a bounded missed-evening catch-up" },
        { id: "day_focus", path: "vault/assistant/processes/day_focus.md", reason: "Disabled for «Минутка»; morning_planning keeps only bounded priority rules without task or project tools" },
      ],
    });
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
    expect([...draftPaths].filter((path) => activePaths.has(path) || disabledPaths.has(path) || legacyPaths.has(path))).toEqual([]);
    expect([...disabledPaths].filter((path) => activePaths.has(path))).toEqual([]);
    expect([...disabledPaths].filter((path) => !processFiles.includes(path))).toEqual([]);
    expect([...activePaths]).toContain("vault/assistant/processes/morning_planning.md");
    expect([...activePaths]).toContain("vault/assistant/processes/midday_adjustment.md");
    expect([...activePaths]).toContain("vault/assistant/processes/personal_context_review.md");
    expect([...activePaths]).toContain("vault/assistant/processes/consent_and_privacy.md");
    expect([...activePaths]).toContain("vault/assistant/processes/evening_reflection.md");
    expect([...activePaths]).toContain("vault/assistant/processes/weekly_summary.md");
    expect([...activePaths]).toContain("vault/assistant/processes/final_report.md");
    expect(legacyPaths).not.toContain("vault/assistant/processes/onboarding.md");
    expect(processFiles).not.toContain("vault/assistant/processes/onboarding.md");
    for (const draft of draftRegistry.drafts) expect(draft.brEpicId).toMatch(/^prs-[a-z0-9]+$/);
    expect(findUnclassifiedProcessFiles(processFiles, activePaths, disabledPaths, draftPaths, legacyPaths)).toEqual([]);
    expect(findUnclassifiedProcessFiles(
      [...processFiles, "vault/assistant/processes/untracked.md"],
      activePaths,
      disabledPaths,
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
    expect(authorityMap).toContain("physical document keys, artifact CAS references, database rows");
    expect(authorityMap).toContain("never loaded into the «Минутка» prompt implicitly");
    expect(authorityMap).toContain("projection is read-only");
    expect(authorityMap).toContain("cannot redefine the «Минутка» role, grant capabilities, select another employee");
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
      processes: source.processes.filter(({ id }: { id: string }) => id !== "evening_reflection"),
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
