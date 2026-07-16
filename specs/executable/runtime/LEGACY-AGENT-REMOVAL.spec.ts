import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mastra } from "../../../src/mastra/index.js";
import { personalAssistantAgent } from "../../../src/mastra/agents/personal-assistant-agent.js";

const source = (path: string) => readFileSync(path, "utf8");

describe("A2.6: legacy Minutka agent removal", () => {
  it("keeps the product runtime free of the legacy agent and chat fallback", async () => {
    expect(existsSync("src/mastra/agents/minutka-agent.ts")).toBe(false);
    expect(Object.keys(await import("../../../src/mastra/agent-runner.js"))).toEqual(["createAssistantAgentRunner"]);
    expect(mastra.getAgent("personalAssistantAgent")).toBe(personalAssistantAgent);
    expect(() => mastra.getAgent("minutkaAgent" as never)).toThrow();

    expect(source("src/runtime/serve.ts")).not.toMatch(/runMinutkaAgent|legacyMinutkaAgentRunner/);
    expect(source("src/runtime/create-postgres-runtime.ts")).not.toContain("createMastraMinutkaServiceDeps");
    expect(source("src/server/http/http-server.ts")).not.toContain("legacyChat");
  });
});
