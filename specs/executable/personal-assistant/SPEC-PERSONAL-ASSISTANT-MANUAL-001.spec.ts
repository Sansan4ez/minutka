import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssistantAgentInstructions } from "../../../src/application/assistant-manual-loader.js";

describe("SPEC-PERSONAL-ASSISTANT-MANUAL-001: assistant process registry", () => {
  it("loads core, the routing index, and process files without preselecting a process", () => {
    const instructions = loadAssistantAgentInstructions();
    expect(instructions).toContain("Personal Assistant runtime instructions");
    expect(instructions).toContain("Agent Vault process index");
    expect(instructions).toContain("Process file: inbox_capture");
    expect(instructions).toContain("Call the typed `captureIdea` action before responding");
    expect(instructions).not.toContain("Active process:");
  });

  it("fails fast when the process registry is malformed", () => {
    const root = mkdtempSync(join(tmpdir(), "assistant-manual-"));
    mkdirSync(join(root, "vault/assistant/processes"), { recursive: true });
    writeFileSync(join(root, "vault/assistant/processes/registry.json"), "{broken");
    expect(() => loadAssistantAgentInstructions({ repoRoot: root })).toThrow();
  });
});
