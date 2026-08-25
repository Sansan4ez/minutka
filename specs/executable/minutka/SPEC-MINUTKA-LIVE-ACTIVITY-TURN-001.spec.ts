import { Agent } from "@mastra/core/agent";
import { describe, expect, it } from "vitest";
import type { AssistantAgentContext } from "../../../src/application/assistant-service.js";
import {
  assistantActiveToolNames,
  createAssistantAgentRunner,
  type MastraAgentLike,
} from "../../../src/mastra/agent-runner.js";

const ordinaryAccount = "Сегодня провёл встречу с коллегами. Система и препятствие не назывались.";

type ActivityTool = {
  execute?: (input: unknown, context: unknown) => Promise<unknown>;
};

type ScriptedStep =
  | { tool: "collectActivities"; input: unknown }
  | { tool: "readRecentOwnActivities" }
  | { tool: "correctRecentActivity"; input: unknown }
  | { tool: "supersedeRecentActivity"; input: unknown };

function context(overrides: Partial<AssistantAgentContext> = {}, sourceText = ordinaryAccount): AssistantAgentContext {
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
    collectActivities: notUsed as never,
    readRecentOwnActivities: notUsed as never,
    correctRecentActivity: notUsed as never,
    supersedeRecentActivity: notUsed as never,
    readWeeklyActivities: notUsed as never,
    readCycleActivities: notUsed as never,
    updatePersonalContext: notUsed as never,
    markProcessUsed() {},
    ...overrides,
  };
}

function scriptedAgent(script: ScriptedStep[], observedActiveTools: string[][]): MastraAgentLike {
  return {
    async generate(_text, options) {
      observedActiveTools.push([...options.activeTools]);
      const activities = options.toolsets.activities as Record<string, ActivityTool>;
      for (const step of script) {
        await activities[step.tool]?.execute?.("input" in step ? step.input : {}, {});
      }
      return { text: "Готово." };
    },
  };
}

describe("SPEC-MINUTKA-LIVE-ACTIVITY-TURN-001: the agent owns activity semantics", () => {
  it("offers every request-scoped activity capability while an ordinary turn writes only evidenced fields", async () => {
    const calls: Array<{ tool: string; input?: unknown }> = [];
    const activeTools: string[][] = [];
    const input = { activities: [{
      taskCategory: "meetings" as const,
    }] };

    await createAssistantAgentRunner(scriptedAgent([{ tool: "collectActivities", input }], activeTools))(
      { userId: "employee", threadId: "thread", text: ordinaryAccount },
      context({
        async collectActivities(received) {
          calls.push({ tool: "collectActivities", input: received });
          return { status: "completed", savedCount: received.activities.length, activityIds: ["activity_1"] };
        },
        async readRecentOwnActivities() {
          calls.push({ tool: "readRecentOwnActivities" });
          return { activities: [] };
        },
        async correctRecentActivity(received) {
          calls.push({ tool: "correctRecentActivity", input: received });
          return { status: "completed", handle: received.handle, revision: received.expectedRevision + 1 };
        },
        async supersedeRecentActivity(received) {
          calls.push({ tool: "supersedeRecentActivity", input: received });
          return { status: "completed", handle: received.handle, revision: received.expectedRevision + 1 };
        },
      }),
    );

    expect(activeTools).toEqual([[...assistantActiveToolNames]]);
    expect(calls).toEqual([{ tool: "collectActivities", input }]);
    expect(input.activities[0]).not.toHaveProperty("system");
    expect(input.activities[0]).not.toHaveProperty("routinePattern");
    expect(input.activities[0]).not.toHaveProperty("automationCandidate");
    expect(input.activities[0]).not.toHaveProperty("energyStressMarker");
  });

  it("preserves the observed multi-activity pilot account with exactly one supported duration", async () => {
    const writes: unknown[] = [];
    const input = { activities: [
      { taskCategory: "admin" as const },
      { taskCategory: "meetings" as const, durationRef: "duration_1" },
      { taskCategory: "focus_work" as const },
      { taskCategory: "focus_work" as const },
      { taskCategory: "communication" as const },
      { taskCategory: "focus_work" as const },
      { taskCategory: "focus_work" as const },
    ] };

    await createAssistantAgentRunner(scriptedAgent([{ tool: "collectActivities", input }], []))(
      {
        userId: "emp_algoritm_institute_07",
        threadId: "pilot",
        text: "Проверила домашние работы, завершила созвон с руководителем — примерно полтора часа, затем готовила материалы, проверяла задания, звонила выпускникам и ещё работала над двумя блоками программы.",
      },
      context({
        async collectActivities(received) {
          writes.push(received);
          return { status: "completed", savedCount: received.activities.length, activityIds: received.activities.map((_, index) => `activity_${index + 1}`) };
        },
      }, "Проверила домашние работы, завершила созвон с руководителем — примерно полтора часа, затем готовила материалы, проверяла задания, звонила выпускникам и ещё работала над двумя блоками программы."),
    );

    expect(writes).toEqual([{ activities: [
      { taskCategory: "admin" },
      { taskCategory: "meetings", durationBucket: "1_2h" },
      { taskCategory: "focus_work" },
      { taskCategory: "focus_work" },
      { taskCategory: "communication" },
      { taskCategory: "focus_work" },
      { taskCategory: "focus_work" },
    ] }]);
  });

  it("rejects a free-standing invented duration and allows the same-loop retry without losing facts", async () => {
    let modelStep = 0;
    const writes: unknown[] = [];
    const model = {
      specificationVersion: "v2",
      provider: "scripted-duration-recovery",
      modelId: "scripted-duration-recovery",
      supportedUrls: {},
      async doGenerate() {
        modelStep += 1;
        const base = { rawCall: { rawPrompt: null, rawSettings: {} }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] };
        if (modelStep === 1) return {
          ...base,
          finishReason: "tool-calls",
          content: [{
            type: "tool-call", toolCallId: "invented", toolName: "collectActivities",
            input: JSON.stringify({ activities: [
              { taskCategory: "meetings", durationBucket: "1_2h" },
              { taskCategory: "reporting", durationBucket: "30_60m" },
            ] }),
          }],
        };
        if (modelStep === 2) return {
          ...base,
          finishReason: "tool-calls",
          content: [{
            type: "tool-call", toolCallId: "honest", toolName: "collectActivities",
            input: JSON.stringify({ activities: [{ taskCategory: "meetings" }, { taskCategory: "reporting" }] }),
          }],
        };
        return { ...base, finishReason: "stop", content: [{ type: "text", text: "Записал обе активности без неподтверждённого времени." }] };
      },
      async doStream() { throw new Error("streaming is not used"); },
    } as never;
    const agent = new Agent({ id: "duration-recovery", name: "duration-recovery", instructions: "Retry invalid activity calls.", model, tools: {}, editor: false });

    const result = await createAssistantAgentRunner(agent)(
      { userId: "employee", threadId: "thread", text: "Провёл встречу и подготовил отчёт." },
      context({
        async collectActivities(received) {
          writes.push(received);
          return { status: "completed", savedCount: received.activities.length, activityIds: ["activity_1", "activity_2"] };
        },
      }, "Провёл встречу и подготовил отчёт."),
    );

    expect(result.text).toContain("обе активности");
    expect(writes).toEqual([{ activities: [{ taskCategory: "meetings" }, { taskCategory: "reporting" }] }]);
    expect(JSON.stringify(result.trace?.toolResults)).toContain("durationBucket");
    expect(JSON.stringify(result.trace?.toolResults)).not.toContain("Провёл встречу");
  });

  it("passes generic amoCRM and 1С mappings without unsupported facets", async () => {
    const writes: unknown[] = [];
    const input = { activities: [
      { taskCategory: "communication" as const, system: "crm" as const },
      { taskCategory: "reporting" as const, system: "one_c" as const },
    ] };

    await createAssistantAgentRunner(scriptedAgent([{ tool: "collectActivities", input }], []))(
      { userId: "employee", threadId: "thread", text: "Работал с клиентами в amoCRM и сверял данные в 1С." },
      context({
        async collectActivities(received) {
          writes.push(received);
          return { status: "completed", savedCount: received.activities.length, activityIds: ["activity_1", "activity_2"] };
        },
      }),
    );

    expect(writes).toEqual([input]);
    expect(input.activities.every((activity) => !("routinePattern" in activity)
      && !("automationCandidate" in activity)
      && !("energyStressMarker" in activity))).toBe(true);
  });

  it("passes valid closed facets to the typed collection use-case without semantic rewriting", async () => {
    const writes: unknown[] = [];
    const input = { activities: [{
      taskCategory: "reporting" as const,
      system: "spreadsheets" as const,
      routinePattern: "manual_reporting" as const,
      automationCandidate: "report_generation" as const,
      energyStressMarker: "frustration" as const,
    }] };

    await createAssistantAgentRunner(scriptedAgent([{ tool: "collectActivities", input }], []))(
      { userId: "employee", threadId: "thread", text: "Multilingual wording is interpreted by the scripted agent." },
      context({
        async collectActivities(received) {
          writes.push(received);
          return { status: "completed", savedCount: received.activities.length, activityIds: ["activity_1"] };
        },
      }),
    );

    expect(writes).toEqual([input]);
  });

  it("recovers an invalid enum call in the same bounded Mastra turn without rewriting arguments", async () => {
    let modelStep = 0;
    const providerPrompts: unknown[] = [];
    const model = {
      specificationVersion: "v2",
      provider: "scripted-activity-recovery",
      modelId: "scripted-activity-recovery",
      supportedUrls: {},
      async doGenerate(options: { prompt: unknown }) {
        providerPrompts.push(options.prompt);
        modelStep += 1;
        const base = {
          rawCall: { rawPrompt: null, rawSettings: {} },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
        if (modelStep === 1) {
          return {
            ...base,
            finishReason: "tool-calls",
            content: [{
              type: "tool-call",
              toolCallId: "invalid_activity",
              toolName: "collectActivities",
              input: JSON.stringify({ activities: [{ taskCategory: "meetings", system: "supplier_portal" }] }),
            }],
          };
        }
        if (modelStep === 2) {
          return {
            ...base,
            finishReason: "tool-calls",
            content: [{
              type: "tool-call",
              toolCallId: "corrected_activity",
              toolName: "collectActivities",
              input: JSON.stringify({ activities: [{ taskCategory: "meetings", durationRef: "duration_1" }] }),
            }],
          };
        }
        return { ...base, finishReason: "stop", content: [{ type: "text", text: "Записал встречу." }] };
      },
      async doStream() { throw new Error("streaming is not used"); },
    } as never;
    const writes: unknown[] = [];
    const agent = new Agent({
      id: "activity-recovery",
      name: "activity-recovery",
      instructions: "Use collectActivities and correct validation failures within the same turn.",
      model,
      tools: {},
      editor: false,
    });

    const result = await createAssistantAgentRunner(agent)(
      { userId: "employee", threadId: "thread", text: "Провёл 35-минутную встречу с поставщиком." },
      context({
        async collectActivities(received) {
          writes.push(received);
          return { status: "completed", savedCount: received.activities.length, activityIds: ["activity_1"] };
        },
      }, "Провёл 35-минутную встречу с поставщиком."),
    );

    expect(result.text).toBe("Записал встречу.");
    expect(modelStep).toBe(3);
    expect(writes).toEqual([{ activities: [{ taskCategory: "meetings", durationBucket: "30_60m" }] }]);
    const recoveryPrompt = JSON.stringify(providerPrompts[1]);
    expect(recoveryPrompt).toContain("Tool input validation failed for collectActivities");
    expect(recoveryPrompt).toContain("activities.0.system");
    expect(recoveryPrompt).toContain("supplier_portal");
    expect(result.trace?.toolResults).toHaveLength(2);
    expect(JSON.stringify(result.trace?.toolResults[0])).toContain("validationErrors");
  });

  it("executes read then one correction for an explicit repair selected by the agent", async () => {
    const calls: Array<{ tool: string; input?: unknown }> = [];
    const correction = {
      handle: "activity_recent",
      expectedRevision: 1,
      mode: "patch" as const,
      correction: { routinePattern: "waiting_for_input" as const },
    };

    await createAssistantAgentRunner(scriptedAgent([
      { tool: "readRecentOwnActivities" },
      { tool: "correctRecentActivity", input: correction },
    ], []))(
      { userId: "employee", threadId: "thread", text: "That last entry needs a correction." },
      context({
        async readRecentOwnActivities() {
          calls.push({ tool: "readRecentOwnActivities" });
          return { activities: [] };
        },
        async correctRecentActivity(received) {
          calls.push({ tool: "correctRecentActivity", input: received });
          return { status: "completed", handle: received.handle, revision: received.expectedRevision + 1 };
        },
      }),
    );

    expect(calls).toEqual([
      { tool: "readRecentOwnActivities" },
      { tool: "correctRecentActivity", input: correction },
    ]);
  });

  it("executes read then exactly one supersession for a confirmed duplicate selected by the agent", async () => {
    const calls: Array<{ tool: string; input?: unknown }> = [];
    const supersession = {
      handle: "activity_duplicate",
      expectedRevision: 1,
      replacementHandle: "activity_keep",
      replacementExpectedRevision: 1,
    };

    await createAssistantAgentRunner(scriptedAgent([
      { tool: "readRecentOwnActivities" },
      { tool: "supersedeRecentActivity", input: supersession },
    ], []))(
      { userId: "employee", threadId: "thread", text: "Ese registro es un duplicado; conserva el anterior." },
      context({
        async readRecentOwnActivities() {
          calls.push({ tool: "readRecentOwnActivities" });
          return { activities: [] };
        },
        async supersedeRecentActivity(received) {
          calls.push({ tool: "supersedeRecentActivity", input: received });
          return { status: "completed", handle: received.handle, revision: received.expectedRevision + 1 };
        },
      }),
    );

    expect(calls).toEqual([
      { tool: "readRecentOwnActivities" },
      { tool: "supersedeRecentActivity", input: supersession },
    ]);
  });

  it.each([
    ["ambiguous candidates", [{ tool: "readRecentOwnActivities" } satisfies ScriptedStep]],
    ["no matching candidate", [{ tool: "readRecentOwnActivities" } satisfies ScriptedStep]],
  ])("leaves application state unchanged for %s", async (_case, script) => {
    const calls: string[] = [];

    await createAssistantAgentRunner(scriptedAgent(script, []))(
      { userId: "employee", threadId: "thread", text: "Please fix the recent entry." },
      context({
        async readRecentOwnActivities() {
          calls.push("readRecentOwnActivities");
          return { activities: [] };
        },
        async correctRecentActivity() {
          calls.push("correctRecentActivity");
          throw new Error("mutation must not be called");
        },
        async supersedeRecentActivity() {
          calls.push("supersedeRecentActivity");
          throw new Error("mutation must not be called");
        },
      }),
    );

    expect(calls).toEqual(["readRecentOwnActivities"]);
  });
});
