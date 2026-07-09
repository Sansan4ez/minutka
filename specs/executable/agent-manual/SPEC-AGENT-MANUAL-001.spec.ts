import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  loadAgentManualFromDisk,
  validateAgentManual,
} from "../../../src/application/agent-manual-loader.js";
import { requiredProcessSections } from "../../../src/application/agent-manual-types.js";
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
    expect(manual.manualId).toBe("minutka-agent-vault");
    expect(manual.core.path).toBe("vault/AGENTS.md");
    expect(manual.processes.length).toBeGreaterThanOrEqual(6);

    expect(manual.processes.map((process) => process.id).sort()).toEqual([
      "consent_and_privacy",
      "evening_reflection",
      "feedback",
      "insight_extraction",
      "onboarding",
      "workday_guardrails",
    ]);

    for (const process of manual.processes) {
      for (const section of requiredProcessSections) {
        expect(process.content).toContain(section);
      }
      expect(process.content).not.toMatch(/\b(TODO|TBD|lorem ipsum)\b/i);
      expect(process.dependencies.length).toBeGreaterThan(0);
    }
  });

  it("keeps process index and virtual namespace contract in sync", () => {
    const manual = loadAgentManualFromDisk();
    const processIndex = readFileSync(
      "vault/processes/index.md",
      "utf8",
    );

    for (const process of manual.processes) {
      expect(processIndex).toContain(`\`${process.id}\``);
    }

    for (const handle of ["/AGENTS.md", "/processes", "/docs", "/proc", "/bin", "/run"]) {
      expect(manual.core.content).toContain(handle);
    }
  });
});
