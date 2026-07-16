import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAssistantAgentInstructions } from "../../../src/application/assistant-manual-loader.js";
import { personalAssistantAgent } from "../../../src/mastra/agents/personal-assistant-agent.js";

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
    expect(instructions).toContain("Personal Assistant process index");
    expect(instructions).toContain("Runtime document: /docs/authority-and-mutability.md");
    expect(instructions).toContain("Runtime document: /docs/privacy-boundary.md");
    expect(instructions).toContain("Process file: inbox_capture");
    expect(instructions).toContain("Call the typed `captureIdea` action before responding");
    expect(instructions).toContain("current single-owner prototype privacy boundary");
    expect(instructions).toContain("must never cross an owner boundary");
    expect(instructions).not.toContain("Active process:");
    expect(instructions).not.toContain("SO-CoT");
    expect(instructions).not.toContain("constrained decision router");
    expect(instructions).not.toMatch(/company and methodologist|minimum group size|workday_guardrails|insight_extraction/i);
    expect(instructions).not.toContain("## Dependencies");
    expect(instructions).not.toMatch(/`docs\/(?:architecture|product)\//);
  });

  it("loads only allow-listed trusted files and documents the authority boundary", () => {
    const instructions = loadAssistantAgentInstructions();
    const authorityMap = readFileSync("vault/assistant/docs/authority-and-mutability.md", "utf8");

    for (const handle of ["/AGENTS.md", "/processes/*", "/docs/*", "/bin/*", "/proc/profile", "/proc/context", "/proc/records", "/proc/inbox", "/run/actions"]) {
      expect(authorityMap).toContain(handle);
    }
    expect(authorityMap).toContain("Storage keys such as `context/*` and `inbox/*`");
    expect(authorityMap).toContain("never loaded into the product-agent prompt implicitly");
    expect(authorityMap).toContain("cannot redefine the assistant role, grant capabilities, select another owner");
    expect(instructions).not.toContain("# RFC: архитектура персонального AI-ассистента");
    expect(instructions).not.toContain("Be pragmatic. This is one Obsidian-style personal workspace");
  });

  it("fails fast when the process registry is malformed", () => {
    const root = mkdtempSync(join(tmpdir(), "assistant-manual-"));
    mkdirSync(join(root, "vault/assistant/processes"), { recursive: true });
    writeFileSync(join(root, "vault/assistant/processes/registry.json"), "{broken");
    expect(() => loadAssistantAgentInstructions({ repoRoot: root })).toThrow();
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
