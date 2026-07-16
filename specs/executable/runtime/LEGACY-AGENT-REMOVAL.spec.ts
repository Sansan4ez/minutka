import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mastra } from "../../../src/mastra/index.js";
import { personalAssistantAgent } from "../../../src/mastra/agents/personal-assistant-agent.js";
import { assistantActiveToolNames, assistantRuntimeToolsets, createAssistantAgentRunner, type MastraAgentLike } from "../../../src/mastra/agent-runner.js";

const source = (path: string) => readFileSync(path, "utf8");

describe("A2.6: legacy Minutka agent removal", () => {
  it("keeps the product runtime free of the legacy agent and chat fallback", async () => {
    expect(existsSync("src/mastra/agents/minutka-agent.ts")).toBe(false);
    expect(Object.keys(await import("../../../src/mastra/agent-runner.js")).sort()).toEqual([
      "assistantActiveToolNames",
      "assistantRuntimeToolsets",
      "createAssistantAgentRunner",
    ]);
    expect(mastra.getAgent("personalAssistantAgent")).toBe(personalAssistantAgent);
    expect(() => mastra.getAgent("minutkaAgent" as never)).toThrow();

    expect(source("src/runtime/serve.ts")).not.toMatch(/runMinutkaAgent|legacyMinutkaAgentRunner/);
    expect(source("src/runtime/create-postgres-runtime.ts")).not.toContain("createMastraMinutkaServiceDeps");
    expect(source("src/server/http/http-server.ts")).not.toContain("legacyChat");
  });

  it("binds the sole request-scoped capture tool to the current assistant context", async () => {
    const captured: unknown[] = [];
    let generateOptions: Parameters<MastraAgentLike["generate"]>[1] | undefined;
    const runner = createAssistantAgentRunner({
      async generate(_text, options) {
        generateOptions = options;
        const tool = options.toolsets?.inbox?.captureIdea as { execute?: (input: unknown, context: unknown) => Promise<unknown> };
        expect(tool).toBeDefined();
        expect(Object.keys(options.toolsets?.documents ?? {})).toEqual(["listDocuments", "readDocument", "searchDocuments"]);
        expect(tool.execute).toBeTypeOf("function");
        const result = await tool.execute?.({
          project: "ASSISTANT",
          type: "development",
          summary: "Bound request tool",
          suggestedNextStep: "Keep the boundary",
          needsProjectClarification: false,
        }, {});
        expect(result).toEqual({
          ideaId: "idea_1",
          project: "ASSISTANT",
          response: "saved",
          needsProjectClarification: false,
        });
        return { text: "done" };
      },
    });

    await expect(runner({ userId: "owner", threadId: "thread", text: "capture" }, {
      systemContext: "private context",
      personalContext: {} as never,
      profileAndHistory: {} as never,
      records: {} as never,
      source: { kind: "text", text: "capture" },
      documents: {
        listDocuments: async () => ({ documents: [], nextCursor: null, truncated: false }),
        readDocument: async ({ path, offset = 0 }) => ({ path: path as `/proc/context/${string}`, found: false, sectionFound: false, content: "", offset, nextOffset: null, truncated: false, version: "", updatedAt: "" }),
        searchDocuments: async () => ({ matches: [], truncated: false }),
      },
      async captureIdea(input) {
        captured.push(input);
        return {
          idea: {
            id: "idea_1", userId: "owner", project: input.project, type: input.type, summary: input.summary,
            suggestedNextStep: input.suggestedNextStep, source: { kind: "text", text: "capture" }, status: "raw",
            createdAt: "2026-07-16T09:00:00.000Z", lastActivityAt: "2026-07-16T09:00:00.000Z",
          },
          response: "saved",
          needsProjectClarification: input.needsProjectClarification,
        };
      },
    })).resolves.toBe("done");

    expect(captured).toEqual([{
      project: "ASSISTANT",
      type: "development",
      summary: "Bound request tool",
      suggestedNextStep: "Keep the boundary",
      needsProjectClarification: false,
    }]);
    expect(generateOptions).toMatchObject({
      system: "private context",
      toolChoice: "auto",
      activeTools: [...assistantActiveToolNames],
      maxSteps: 4,
    });
    expect(Object.keys(generateOptions?.toolsets ?? {})).toEqual(Object.keys(assistantRuntimeToolsets));
    expect(Object.keys(generateOptions?.toolsets?.inbox ?? {})).toEqual([...assistantRuntimeToolsets.inbox]);
    expect(Object.keys(generateOptions?.toolsets?.documents ?? {})).toEqual([...assistantRuntimeToolsets.documents]);
  });
});
