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
        expect(Object.keys(options.toolsets?.tasks ?? {})).toEqual(["listTasks", "proposeTaskMutation", "proposeIdeaToTask"]);
        const diagnostic = options.toolsets?.diagnostics?.markProcessUsed as { execute?: (input: unknown, context: unknown) => Promise<unknown> };
        expect(diagnostic.execute).toBeTypeOf("function");
        await expect(diagnostic.execute?.({ id: "day_focus" }, {})).resolves.toEqual({ recorded: true, id: "day_focus" });
        await expect(diagnostic.execute?.({ id: "unknown" }, {})).resolves.toMatchObject({ error: true });
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
        return {
          text: "done",
          toolCalls: [
            { payload: { toolCallId: "call-1", toolName: "markProcessUsed" } },
            { payload: { toolCallId: "call-2", toolName: "captureIdea" } },
          ],
          toolResults: [
            { payload: { toolCallId: "call-1", toolName: "markProcessUsed", isError: false } },
            { payload: { toolCallId: "call-2", toolName: "captureIdea", isError: false } },
          ],
        };
      },
    });

    await expect(runner({ userId: "owner", threadId: "thread", text: "capture" }, {
      systemContext: "private context",
      personalContext: {} as never,
      profileAndHistory: {} as never,
      records: {} as never,
      source: { kind: "text", text: "capture" },
      tasks: {
        async list() { return []; },
        async propose() { throw new Error("unused"); },
        async proposeIdeaToTask() { return { status: "not_found" }; },
      },
      documents: {
        limits: {
          listDefault: 20,
          listMaximum: 50,
          readDefaultCharacters: 4_000,
          readMaximumCharacters: 8_000,
          turnReadCharacters: 20_000,
          maximumDocumentBytes: 100_000,
          turnScanBytes: 200_000,
          searchDefault: 10,
          searchMaximum: 20,
          searchSnippetCharacters: 500,
        },
        listDocuments: async () => ({ documents: [], nextCursor: null, truncated: false }),
        readDocument: async ({ path, offset = 0 }) => ({
          path: path as `/proc/context/${string}`, found: false, sectionFound: false, content: "", offset,
          totalCharacters: null, nextOffset: null, truncated: false, readBudgetExhausted: false,
          scanBudgetExhausted: false, documentTooLarge: false, hint: null, version: "", updatedAt: "",
        }),
        searchDocuments: async () => ({
          matches: [], truncated: false, readBudgetExhausted: false, scanBudgetExhausted: false,
          documentTooLarge: false, hint: null,
        }),
      },
      markProcessUsed(id) {
        expect(id).toBe("day_focus");
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
    })).resolves.toEqual({
      text: "done",
      executionTrace: [
        { kind: "tool", toolName: "markProcessUsed" },
        { kind: "tool", toolName: "captureIdea" },
      ],
    });

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
    expect(Object.keys(generateOptions?.toolsets?.tasks ?? {})).toEqual([...assistantRuntimeToolsets.tasks]);
    expect(Object.keys(generateOptions?.toolsets?.diagnostics ?? {})).toEqual([...assistantRuntimeToolsets.diagnostics]);
  });
});
