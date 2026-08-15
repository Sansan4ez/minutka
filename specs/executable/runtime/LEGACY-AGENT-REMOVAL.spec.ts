import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { mastra } from "../../../src/mastra/index.js";
import { createTaskTools } from "../../../src/mastra/tools/task-tools.js";
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
      "createAssistantToolsets",
    ]);
    expect(mastra.getAgent("personalAssistantAgent")).toBe(personalAssistantAgent);
    expect(() => mastra.getAgent("minutkaAgent" as never)).toThrow();

    expect(source("src/runtime/serve.ts")).not.toMatch(/runMinutkaAgent|legacyMinutkaAgentRunner/);
    expect(source("src/runtime/create-postgres-runtime.ts")).not.toContain("createMastraMinutkaServiceDeps");
    expect(source("src/server/http/http-server.ts")).not.toContain("legacyChat");
  });

  it("keeps every task proposal form compatible with OpenAI Responses", async () => {
    const proposals: unknown[] = [];
    const tools = createTaskTools({
      async list() { return []; },
      async propose(input) {
        proposals.push(input);
        return { confirmationId: `confirmation-${proposals.length}`, actionKind: input.kind, summary: "proposal", expiresAt: "2026-07-31T21:00:00.000Z" };
      },
      async proposeIdeaToTask() { return { status: "not_found" }; },
      async undoLast() { return { status: "not_found" }; },
    });
    const schema = tools.proposeTaskMutation.inputSchema!["~standard"].jsonSchema.input({ target: "draft-07" });

    expect(JSON.stringify(schema)).not.toMatch(/"oneOf"|"anyOf"/);
    await expect(tools.proposeTaskMutation.execute?.({
      kind: "create", title: "Provider-safe task", project: "ASSISTANT", type: "operations",
    }, {} as never)).resolves.toMatchObject({ actionKind: "create" });
    await expect(tools.proposeTaskMutation.execute?.({
      kind: "update", taskId: "task-1", expectedRevision: 1, patch: { clearDueDate: true },
    }, {} as never)).resolves.toMatchObject({ actionKind: "update" });
    await expect(tools.proposeTaskMutation.execute?.({
      kind: "complete", taskId: "task-1", expectedRevision: 1,
    }, {} as never)).resolves.toMatchObject({ actionKind: "complete" });
    await expect(tools.proposeTaskMutation.execute?.({
      kind: "complete", taskId: "task-1", expectedRevision: 1, title: null, project: null, patch: null,
    } as never, {} as never)).resolves.toMatchObject({ actionKind: "complete" });
    await expect(tools.proposeTaskMutation.execute?.({
      kind: "complete", taskId: "task-1",
    }, {} as never)).resolves.toMatchObject({ actionKind: "complete" });
    await expect(tools.proposeTaskMutation.execute?.({
      kind: "cancel", taskId: "task-1", expectedRevision: 1,
    }, {} as never)).resolves.toMatchObject({ actionKind: "cancel" });
    await expect(tools.proposeTaskMutation.execute?.({
      kind: "create", taskId: "wrong-shape",
    } as never, {} as never)).resolves.toMatchObject({ status: "invalid_request" });
    await expect(tools.proposeTaskMutation.execute?.({
      kind: "complete", type: "personal", taskId: "task-1", expectedRevision: 1,
    } as never, {} as never)).resolves.toMatchObject({ actionKind: "complete" });
    expect(proposals).toEqual([
      { kind: "create", title: "Provider-safe task", project: "ASSISTANT", type: "operations" },
      { kind: "update", taskId: "task-1", expectedRevision: 1, patch: { dueDate: null } },
      { kind: "complete", taskId: "task-1", expectedRevision: 1 },
      { kind: "complete", taskId: "task-1", expectedRevision: 1 },
      { kind: "complete", taskId: "task-1" },
      { kind: "cancel", taskId: "task-1", expectedRevision: 1 },
      { kind: "complete", taskId: "task-1", expectedRevision: 1 },
    ]);
  });

  it("binds request-scoped tools to safe model-visible outputs", async () => {
    const captured: unknown[] = [];
    const providerToolTrace: unknown[] = [];
    let generateOptions: Parameters<MastraAgentLike["generate"]>[1] | undefined;
    const runner = createAssistantAgentRunner({
      async generate(_text, options) {
        generateOptions = options;
        const tool = options.toolsets?.inbox?.captureIdea as { execute?: (input: unknown, context: unknown) => Promise<unknown> };
        expect(tool).toBeDefined();
        expect(Object.keys(options.toolsets?.documents ?? {})).toEqual(["listDocuments", "readDocument", "searchDocuments"]);
        expect(Object.keys(options.toolsets?.contextDocuments ?? {})).toEqual(["createContextNote", "proposeContextDocumentUpdate", "proposeContextDocumentMove", "proposeContextDocumentDelete"]);
        expect(Object.keys(options.toolsets?.tasks ?? {})).toEqual(["listTasks", "proposeTaskMutation", "proposeIdeaToTask", "undoTaskMutation"]);
        expect(Object.keys(options.toolsets?.schedules ?? {})).toEqual(["listSchedules", "setDailySchedule", "disableSchedule"]);
        const taskTools = options.toolsets?.tasks as Record<string, { execute?: (input: unknown, context: unknown) => Promise<unknown> }>;
        const taskProposal = await taskTools.proposeTaskMutation?.execute?.({
          kind: "create", title: "Trace-safe task", project: "ASSISTANT", type: "operations",
        }, {});
        const ideaProposal = await taskTools.proposeIdeaToTask?.execute?.({ ideaId: "idea-owner" }, {});
        providerToolTrace.push(taskProposal, ideaProposal);
        expect(taskProposal).toEqual({
          confirmationId: "confirmation-1", actionKind: "create", summary: "Создать задачу: Trace-safe task", expiresAt: "2026-07-16T09:15:00.000Z",
        });
        expect(ideaProposal).toEqual({ status: "not_found" });
        expect(JSON.stringify(providerToolTrace)).not.toMatch(/ownerId|proposal|payloadDigest|task-generated|originIdeaId|createdAt/);
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
          usage: { promptTokens: 70, completionTokens: 20, totalTokens: 90, cachedInputTokens: 50 },
          totalUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, cachedInputTokens: 80 },
          steps: [
            { usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedInputTokens: 30 } },
            { usage: { inputTokens: 70, outputTokens: 20, totalTokens: 90, cachedInputTokens: 50 } },
          ],
        };
      },
    });

    const abortController = new AbortController();
    await expect(runner({ userId: "owner", threadId: "thread", text: "capture" }, {
      systemContext: "private context",
      personalContext: {} as never,
      profileAndHistory: {} as never,
      records: {} as never,
      source: { kind: "text", text: "capture" },
      tasks: {
        async list() { return []; },
        async propose() {
          return { confirmationId: "confirmation-1", actionKind: "create", summary: "Создать задачу: Trace-safe task", expiresAt: "2026-07-16T09:15:00.000Z" };
        },
        async proposeIdeaToTask() {
          return { status: "not_found" };
        },
        async undoLast() { return { status: "not_found" }; },
      },
      contextDocuments: {
        async createNote() { return { outcome: "created", path: "/proc/context/00_inbox/safe.md", version: "version-1" }; },
        async proposeUpdate() { return { status: "not_found" }; },
        async proposeMove() { return { status: "not_found" }; },
        async proposeDelete() { return { status: "not_found" }; },
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
      ideas: {
        search: async () => [],
        append: async () => ({ status: "not_found" }),
        propose: async () => ({ status: "not_found" }),
        undo: async () => ({ outcome: "not_found" }),
      },
      projects: {
        list: async () => ({ projects: [], truncated: false }),
      },
      schedules: {
        listSchedules: async () => [],
        saveDailySchedule: async () => { throw new Error("not used"); },
        disableSchedule: async () => null,
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
            revision: 1, createdAt: "2026-07-16T09:00:00.000Z", lastActivityAt: "2026-07-16T09:00:00.000Z",
          },
          response: "saved",
          needsProjectClarification: input.needsProjectClarification,
        };
      },
    }, abortController.signal)).resolves.toEqual({
      text: "done",
      executionTrace: [
        { kind: "tool", toolName: "markProcessUsed" },
        { kind: "tool", toolName: "captureIdea" },
      ],
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, llmSteps: 2, cachedInputTokens: 80 },
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
      abortSignal: abortController.signal,
    });
    expect(Object.keys(generateOptions?.toolsets ?? {})).toEqual(Object.keys(assistantRuntimeToolsets));
    expect(Object.keys(generateOptions?.toolsets?.inbox ?? {})).toEqual([...assistantRuntimeToolsets.inbox]);
    expect(Object.keys(generateOptions?.toolsets?.documents ?? {})).toEqual([...assistantRuntimeToolsets.documents]);
    expect(Object.keys(generateOptions?.toolsets?.contextDocuments ?? {})).toEqual([...assistantRuntimeToolsets.contextDocuments]);
    expect(Object.keys(generateOptions?.toolsets?.ideas ?? {})).toEqual([...assistantRuntimeToolsets.ideas]);
    expect(Object.keys(generateOptions?.toolsets?.tasks ?? {})).toEqual([...assistantRuntimeToolsets.tasks]);
    expect(Object.keys(generateOptions?.toolsets?.projects ?? {})).toEqual([...assistantRuntimeToolsets.projects]);
    expect(Object.keys(generateOptions?.toolsets?.schedules ?? {})).toEqual([...assistantRuntimeToolsets.schedules]);
    expect(Object.keys(generateOptions?.toolsets?.activities ?? {})).toEqual([...assistantRuntimeToolsets.activities]);
    expect(Object.keys(generateOptions?.toolsets?.diagnostics ?? {})).toEqual([...assistantRuntimeToolsets.diagnostics]);
  });

  it("falls back to one coherent per-turn usage source", async () => {
    const stepsRunner = createAssistantAgentRunner({
      async generate() {
        return {
          text: "steps",
          usage: { inputTokens: 70, outputTokens: 20, totalTokens: 90, cachedInputTokens: 50 },
          steps: [
            { usage: { inputTokens: 50, outputTokens: 10, totalTokens: 60, cachedInputTokens: 30 } },
            { usage: { promptTokens: 70, completionTokens: 20, totalTokens: 90, cachedInputTokens: 50 } },
          ],
        };
      },
    });
    await expect(runUsageOnly(stepsRunner)).resolves.toEqual({
      text: "steps",
      executionTrace: [],
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150, llmSteps: 2, cachedInputTokens: 80 },
    });

    const lastStepRunner = createAssistantAgentRunner({
      async generate() {
        return { text: "last", usage: { promptTokens: 40, completionTokens: 5, cachedInputTokens: 10 } };
      },
    });
    await expect(runUsageOnly(lastStepRunner)).resolves.toEqual({
      text: "last",
      executionTrace: [],
      usage: { inputTokens: 40, outputTokens: 5, totalTokens: 45, llmSteps: 1, cachedInputTokens: 10 },
    });
  });

  it("drops inconsistent cached tokens without dropping turn usage", async () => {
    const warnings: unknown[] = [];
    const runner = createAssistantAgentRunner({
      async generate() {
        return {
          text: "done",
          totalUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 101 },
          steps: [{ usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 101 } }],
        };
      },
    }, { operationalLogger: (warning) => warnings.push(warning) });

    await expect(runUsageOnly(runner)).resolves.toEqual({
      text: "done",
      executionTrace: [],
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, llmSteps: 1 },
    });
    expect(warnings).toEqual([{
      type: "assistant_agent_usage_cached_input_exceeds_input",
      source: "totalUsage",
      inputTokens: 100,
      cachedInputTokens: 101,
    }]);
  });
});

function runUsageOnly(runner: ReturnType<typeof createAssistantAgentRunner>) {
  return runner({ userId: "owner", threadId: "thread", text: "usage" }, {
    systemContext: "private context",
    personalContext: {} as never,
    profileAndHistory: {} as never,
    records: {} as never,
    source: { kind: "text", text: "usage" },
    captureIdea: async () => { throw new Error("not used"); },
    contextDocuments: {} as never,
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
      readDocument: async ({ path, offset = 0 }: { path: string; offset?: number }) => ({
        path, found: false, sectionFound: false, content: "", offset, totalCharacters: null, nextOffset: null,
        truncated: false, readBudgetExhausted: false, scanBudgetExhausted: false, documentTooLarge: false,
        hint: null, version: "", updatedAt: "",
      }),
      searchDocuments: async () => ({
        matches: [], truncated: false, readBudgetExhausted: false, scanBudgetExhausted: false,
        documentTooLarge: false, hint: null,
      }),
    } as never,
    ideas: {} as never,
    tasks: {} as never,
    projects: {} as never,
    schedules: {} as never,
    markProcessUsed() {},
  });
}
