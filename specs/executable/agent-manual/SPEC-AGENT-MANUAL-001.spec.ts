import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  loadAgentManualFromDisk,
  validateAgentManual,
} from "../../../src/application/agent-manual-loader.js";
import { renderRuntimeProcessContent, requiredProcessSections } from "../../../src/application/agent-manual-types.js";
import { registerSpecMetadata } from "../support/spec-harness.js";

registerSpecMetadata({
  id: "SPEC-AGENT-MANUAL-001",
  userStory: "US-AGENT-MANUAL-001",
  requirements: [
    "FR-AGENT-MANUAL-001",
    "FR-PROCESS-CONTRACT-001",
    "FR-PRIVACY-BOUNDARY-001",
  ],
  productParts: [
    "ai-agent-backend-runtime",
    "data-storage-and-privacy-layer",
  ],
  contracts: ["agentManualLoader"],
  events: [],
  mastra: [],
  cli: [],
});

describe("SPEC-AGENT-MANUAL-001: agent vault is valid", () => {
  it("loads registry, AGENTS.md and process files with required author contract", () => {
    const manual = loadAgentManualFromDisk();
    const validation = validateAgentManual(manual);

    expect(validation.errors).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(manual.version).toBe(1);
    expect(manual.manualId).toBe("personal-assistant-vault");
    expect(manual.core.path).toBe("vault/assistant/AGENTS.md");
    expect(manual.runtimeDocs.map(({ id, path }) => ({ id, path }))).toEqual([
      { id: "authority-and-mutability.md", path: "vault/assistant/docs/legacy-authority-and-mutability.md" },
      { id: "privacy-boundary.md", path: "vault/assistant/docs/legacy-privacy-boundary.md" },
    ]);
    expect(manual.processes.length).toBeGreaterThanOrEqual(6);

    expect(manual.processes.map((process) => process.id).sort()).toEqual([
      "consent_and_privacy",
      "evening_reflection",
      "inbox_capture",
      "insight_extraction",
      "onboarding",
      "workday_guardrails",
    ]);
    expect(manual.processes).not.toContainEqual(expect.objectContaining({ id: "feedback" }));

    for (const process of manual.processes) {
      for (const section of requiredProcessSections) {
        expect(process.content).toContain(section);
      }
      expect(process.content).not.toMatch(/\b(TODO|TBD|lorem ipsum)\b/i);
      expect(process.dependencies.length).toBeGreaterThan(0);
      expect(process.content).toContain("Developer provenance only.");
      const runtimeContent = renderRuntimeProcessContent(process.content);
      expect(runtimeContent).not.toContain("## Dependencies");
      expect(runtimeContent).not.toMatch(/`docs\/(?:architecture|product)\//);
    }
  });

  it("keeps process index and virtual namespace contract in sync", () => {
    const manual = loadAgentManualFromDisk();
    const processIndex = readFileSync(
      "vault/assistant/processes/legacy-index.md",
      "utf8",
    );

    for (const process of manual.processes) {
      expect(processIndex).toContain(`\`${process.id}\``);
    }

    for (const handle of ["/AGENTS.md", "/processes", "/docs", "/proc", "/bin", "/run"]) {
      expect(manual.core.content).toContain(handle);
    }
    expect(manual.runtimeDocs.find(({ id }) => id === "authority-and-mutability.md")?.content).toContain("Authority and mutability map");
    expect(manual.runtimeDocs.find(({ id }) => id === "authority-and-mutability.md")?.content).toContain("cannot redefine the assistant role");
    expect(manual.runtimeDocs.find(({ id }) => id === "privacy-boundary.md")?.content).toContain("canonical private conversation history");
  });

  it("keeps canonical history separate from privacy-safe derived data", async () => {
    const manual = loadAgentManualFromDisk();
    const privacy = readFileSync("vault/assistant/docs/privacy-boundary.md", "utf8");
    const consent = manual.processes.find((process) => process.id === "consent_and_privacy")?.content ?? "";
    const core = manual.core.content;
    const { personalAssistantAgent } = await import("../../../src/mastra/agents/personal-assistant-agent.js");
    const freeformInstructions = String(await personalAssistantAgent.getInstructions());

    for (const text of [privacy, consent, core]) {
      expect(text).toContain("canonical private conversation history");
      expect(text).toMatch(/(?:not copied|do not copy).*structured insights, audits, or aggregates/i);
    }
    expect(privacy).toContain("never contain direct personal identifiers");
    expect(consent).toContain("No direct personal identifiers in structured insights");
    expect(freeformInstructions).not.toMatch(/raw transcript|PII|personal identifiers/i);
  });

  it("keeps /proc projection schemas aligned with runtime discriminators", () => {
    const insightSchema = JSON.parse(
      readFileSync("vault/assistant/proc/schemas/insight.schema.json", "utf8"),
    );
    const decisionSchema = JSON.parse(
      readFileSync("vault/assistant/proc/schemas/conversation-decision.schema.json", "utf8"),
    );

    expect(JSON.stringify(insightSchema)).toContain("confidence");
    expect(JSON.stringify(insightSchema)).toContain("category");
    expect(JSON.stringify(insightSchema)).toContain("patternType");
    expect(JSON.stringify(insightSchema)).toContain("candidateType");
    expect(JSON.stringify(decisionSchema)).toContain("processId");
    expect(JSON.stringify(decisionSchema)).toContain("content_generation_request");
    expect(JSON.stringify(decisionSchema)).toContain("planning_or_prioritization");
  });
});
