import { Agent } from "@mastra/core/agent";
import { describe, expect, it } from "vitest";
import type { AssistantAgentContext } from "../../../src/application/assistant-service.js";
import type { ActivityTransactionServiceResult } from "../../../src/application/activity-transaction-service.js";
import {
  assistantActiveToolNames,
  createAssistantAgentRunner,
  createAssistantToolsets,
  type MastraAgentLike,
} from "../../../src/mastra/agent-runner.js";

const extraction = {
  context: {
    currentTextCharacters: 24,
    staticRulesCharacters: 100,
    durationReferencesCharacters: 0,
    recentCandidatesCharacters: 0,
    promptCharacters: 124,
  },
};

function context(
  processCurrentActivityTurn: AssistantAgentContext["processCurrentActivityTurn"],
  sourceText = "Сегодня провёл встречу с коллегами.",
): AssistantAgentContext {
  const notUsed = async () => { throw new Error("not used"); };
  return {
    systemContext: "runtime",
    personalContext: {} as never,
    profileAndHistory: {} as never,
    records: {} as never,
    source: { kind: "text", text: sourceText },
    captureIdea: notUsed as never,
    documents: {} as never,
    contextDocuments: {} as never,
    tasks: {} as never,
    ideas: {} as never,
    projects: {} as never,
    schedules: {} as never,
    processCurrentActivityTurn,
    collectActivities: notUsed as never,
    readRecentOwnActivities: notUsed as never,
    correctRecentActivity: notUsed as never,
    supersedeRecentActivity: notUsed as never,
    readWeeklyActivities: notUsed as never,
    readCycleActivities: notUsed as never,
    updatePersonalContext: notUsed as never,
    markProcessUsed() {},
  };
}

function scriptedAgent(
  mode: "record" | "repair",
  observed: { activeTools: string[][]; results: unknown[]; calls: number },
): MastraAgentLike {
  return {
    async generate(_text, options) {
      observed.activeTools.push([...options.activeTools]);
      const tool = options.toolsets.activities.processCurrentActivityTurn as {
        execute(input: unknown, context: unknown): Promise<unknown>;
      };
      observed.calls += 1;
      observed.results.push(await tool.execute({ mode }, {}));
      return { text: "Финальный ответ после результата." };
    },
  };
}

describe("SPEC-MINUTKA-LIVE-ACTIVITY-TURN-001: broad agent uses one request-bound activity tool", () => {
  it("removes low-level activity tools and exposes only the closed high-level mode", async () => {
    const toolsets = createAssistantToolsets(context(async () => ({
      status: "no_write", reason: "no_factual_activity", extraction,
    })));
    const activityTools = Object.keys(toolsets.activities);
    const tool = toolsets.activities.processCurrentActivityTurn;
    const schema = tool.inputSchema!["~standard"].jsonSchema.input({ target: "draft-07" }) as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };

    expect(activityTools).toEqual(["processCurrentActivityTurn", "readWeeklyActivities", "readCycleActivities"]);
    expect(assistantActiveToolNames).not.toEqual(expect.arrayContaining([
      "collectActivities", "readRecentOwnActivities", "correctRecentActivity", "supersedeRecentActivity",
    ]));
    expect(Object.keys(schema.properties ?? {})).toEqual(["mode"]);
    expect(schema.additionalProperties).toBe(false);
    expect(JSON.stringify(schema)).not.toMatch(/currentText|employeeId|companyId|groupId|subjectKey|facets|handle|revision/u);
  });

  it.each([
    ["ordinary record", "record", { status: "completed", operation: "collect", savedCount: 3, activityIds: ["a", "b", "c"], extraction }],
    ["explicit correction", "repair", { status: "completed", operation: "correct", handle: "recent", revision: 2, extraction }],
    ["confirmed duplicate", "repair", { status: "completed", operation: "supersede", handle: "duplicate", revision: 3, extraction }],
  ] as const)("runs %s through exactly one transaction before final text", async (_label, mode, serviceResult) => {
    const observed = { activeTools: [] as string[][], results: [] as unknown[], calls: 0 };
    const boundCalls: Array<{ mode: "record" | "repair" }> = [];
    const result = await createAssistantAgentRunner(scriptedAgent(mode, observed))(
      { userId: "employee", threadId: "thread", text: "Current authenticated turn" },
      context(async (input) => {
        boundCalls.push(input);
        return serviceResult as ActivityTransactionServiceResult;
      }),
    );

    expect(observed.activeTools).toEqual([[...assistantActiveToolNames]]);
    expect(observed.calls).toBe(1);
    expect(boundCalls).toEqual([{ mode }]);
    expect(observed.results).toEqual([mode === "record"
      ? { status: "completed", operation: "collect", savedCount: 3 }
      : { status: "completed", operation: serviceResult.operation, revision: serviceResult.revision }]);
    expect(result.text).toBe("Финальный ответ после результата.");
  });

  it("requires a typed result step before a model can claim successful collection", async () => {
    let modelStep = 0;
    const model = {
      specificationVersion: "v2",
      provider: "scripted-activity-transaction",
      modelId: "scripted-activity-transaction",
      supportedUrls: {},
      async doGenerate() {
        modelStep += 1;
        const base = { rawCall: { rawPrompt: null, rawSettings: {} }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
        if (modelStep === 1) return {
          ...base,
          finishReason: "tool-calls",
          content: [{
            type: "tool-call", toolCallId: "activity", toolName: "processCurrentActivityTurn",
            input: JSON.stringify({ mode: "record" }),
          }],
        };
        return { ...base, finishReason: "stop", content: [{ type: "text", text: "Записал две активности." }] };
      },
      async doStream() { throw new Error("streaming is not used"); },
    } as never;
    const agent = new Agent({ id: "activity-transaction", name: "activity-transaction", instructions: "Use the typed result before answering.", model, tools: {}, editor: false });

    const result = await createAssistantAgentRunner(agent)(
      { userId: "employee", threadId: "thread", text: "Завершил отчёт и созвон." },
      context(async () => ({ status: "completed", operation: "collect", savedCount: 2, activityIds: ["a", "b"], extraction })),
    );

    expect(modelStep).toBe(2);
    expect(result.text).toBe("Записал две активности.");
    expect(JSON.stringify(result.trace?.toolCalls)).toContain("processCurrentActivityTurn");
    expect(JSON.stringify(result.trace?.toolResults)).toContain('"savedCount":2');
  });

  it.each([
    [{ status: "no_write", reason: "no_factual_activity", extraction }, { status: "no_write", reason: "no_factual_activity" }],
    [{ status: "needs_clarification", reason: "correction_target_ambiguous", extraction }, { status: "needs_clarification", reason: "correction_target_ambiguous" }],
    [{ status: "failed", phase: "extract", code: "provider_error", extraction }, { status: "failed", phase: "extract", code: "provider_error" }],
    [{ status: "outcome_unknown", phase: "write", extraction }, { status: "outcome_unknown", phase: "write" }],
  ] as const)("returns compact model-visible outcomes without extraction internals", async (serviceResult, expected) => {
    const tool = createAssistantToolsets(context(async () => serviceResult as ActivityTransactionServiceResult))
      .activities.processCurrentActivityTurn;

    await expect(tool.execute?.({ mode: "repair" }, {} as never)).resolves.toEqual(expected);
  });
});
