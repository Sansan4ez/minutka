import { describe, expect, it } from "vitest";
import type { AssistantAgentContext } from "../../../src/application/assistant-service.js";
import {
  assistantActiveToolNames,
  createAssistantAgentRunner,
  type MastraAgentLike,
} from "../../../src/mastra/agent-runner.js";

const ordinaryAccount = "Сегодня провёл встречу с коллегами. Система и препятствие не назывались.";

function context(overrides: Partial<AssistantAgentContext> = {}): AssistantAgentContext {
  const notUsed = async () => { throw new Error("not used"); };
  return {
    systemContext: "runtime",
    personalContext: {} as never,
    profileAndHistory: {} as never,
    records: {} as never,
    source: { kind: "text", text: ordinaryAccount },
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

describe("SPEC-MINUTKA-LIVE-ACTIVITY-TURN-001: ordinary account stays an ordinary write", () => {
  it("omits unsupported facets and removes correction authority from the live tool sequence", async () => {
    const writes: unknown[] = [];
    let activeTools: string[] = [];
    const agent: MastraAgentLike = {
      async generate(_text, options) {
        activeTools = options.activeTools;
        const activities = options.toolsets.activities as Record<string, {
          execute?: (input: unknown, context: unknown) => Promise<unknown>;
        }>;

        expect(activeTools).toContain("collectActivities");
        expect(activeTools).not.toContain("readRecentOwnActivities");
        expect(activeTools).not.toContain("correctRecentActivity");
        expect(activeTools).not.toContain("supersedeRecentActivity");
        await activities.collectActivities?.execute?.({ activities: [{
          taskCategory: "meetings",
          system: "other",
          routinePattern: "other",
          automationCandidate: "other",
          energyStressMarker: "neutral",
        }] }, {});

        return { text: "Записал встречу." };
      },
    };

    await createAssistantAgentRunner(agent)(
      { userId: "employee", threadId: "thread", text: ordinaryAccount },
      context({
        async collectActivities(input) {
          writes.push(input);
          return { status: "completed", savedCount: input.activities.length, activityIds: ["activity_1"] };
        },
      }),
    );

    expect(writes).toEqual([{ activities: [{ taskCategory: "meetings" }] }]);
    expect(activeTools).toHaveLength(assistantActiveToolNames.length - 3);
  });

  it.each([
    "Исправь предыдущую встречу: препятствием было ожидание входных данных.",
    "Последняя запись — дубликат первой встречи с коллегами. Удали дубликат и оставь первую запись.",
    "Последняя встреча дублируется, оставь предыдущую запись.",
  ])("keeps bounded correction tools available for an explicit repair turn: %s", async (text) => {
    let activeTools: string[] = [];
    const agent: MastraAgentLike = {
      async generate(_text, options) {
        activeTools = options.activeTools;
        return { text: "Уточню запись." };
      },
    };

    await createAssistantAgentRunner(agent)(
      { userId: "employee", threadId: "thread", text },
      context(),
    );

    expect(activeTools).toEqual([...assistantActiveToolNames]);
  });

  it("preserves explicit covered facets instead of flattening the activity", async () => {
    const writes: unknown[] = [];
    const agent: MastraAgentLike = {
      async generate(_text, options) {
        await options.toolsets.activities.collectActivities.execute({ activities: [{
          taskCategory: "reporting",
          system: "spreadsheets",
          routinePattern: "manual_reporting",
          automationCandidate: "report_generation",
          energyStressMarker: "frustration",
        }] }, {});
        return { text: "Записал." };
      },
    };

    await createAssistantAgentRunner(agent)(
      {
        userId: "employee",
        threadId: "thread",
        text: "Готовил отчёт вручную в таблице, это раздражало; такую подготовку можно автоматизировать.",
      },
      context({
        async collectActivities(input) {
          writes.push(input);
          return { status: "completed", savedCount: input.activities.length, activityIds: ["activity_1"] };
        },
      }),
    );

    expect(writes).toEqual([{ activities: [{
      taskCategory: "reporting",
      system: "spreadsheets",
      routinePattern: "manual_reporting",
      automationCandidate: "report_generation",
      energyStressMarker: "frustration",
    }] }]);
  });
});
