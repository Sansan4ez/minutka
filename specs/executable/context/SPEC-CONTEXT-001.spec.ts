import { describe, expect, it } from "vitest";
import type {
  AgentRunContext,
  AgentRunner,
  ChatInput,
  ChatResult,
} from "../../../src/application/minutka-service.js";
import type { StructuredInsightResult } from "../../../src/client/sdk/minutka-client.js";
import {
  createSpecWorld,
  expectEvent,
  registerSpecMetadata,
} from "../support/spec-harness.js";
import {
  eveningReflectionText,
  morningPlanText,
  testEmployee,
} from "../support/fixtures.js";
import { onboardTestEmployee } from "../support/onboarding-helper.js";

registerSpecMetadata({
  id: "SPEC-CONTEXT-001",
  userStory: "US-CONTEXT-001",
  requirements: ["FR-CONTEXT-001", "FR-MEMORY-001", "FR-INSIGHTS-001"],
  productParts: [
    "ai-agent-backend-runtime",
    "data-storage-and-privacy-layer",
  ],
  contracts: ["chat", "listInsights"],
  events: [
    "ChatMessageReceived",
    "ChatResponseGenerated",
    "InsightRecorded",
  ],
  mastra: [
    "minutkaAgent",
    "minutkaMemory",
    "extractInsightsTool",
    "runMinutkaAgent",
    "routeAgentManualProcesses",
  ],
  cli: [
    "employee open-invite",
    "employee accept-consent",
    "employee complete-onboarding",
    "employee chat",
    "employee insights",
  ],
});

describe("SPEC-CONTEXT-001: thread context and structured insights", () => {
  it("Mastra memory, runner and insight tool are importable", async () => {
    const { minutkaAgent } = await import(
      "../../../src/mastra/agents/minutka-agent.js"
    );
    const { minutkaMemory } = await import("../../../src/mastra/memory.js");
    const { extractInsightsTool } = await import(
      "../../../src/mastra/tools/extract-insights-tool.js"
    );
    const { runMinutkaAgent } = await import(
      "../../../src/mastra/agent-runner.js"
    );
    const { routeAgentManualProcesses } = await import(
      "../../../src/mastra/agent-manual-router.js"
    );

    expect(minutkaAgent).toBeDefined();
    expect(minutkaMemory).toBeDefined();
    expect(extractInsightsTool).toBeDefined();
    expect(runMinutkaAgent).toBeDefined();
    expect(routeAgentManualProcesses).toBeDefined();
  });

  it("uses morning plan in evening reflection and records privacy-safe insights", async () => {
    const observedRuns: Array<{ input: ChatInput; context?: AgentRunContext }> = [];
    const mockAgentRunner: AgentRunner = async (input, context) => {
      observedRuns.push({ input, context });
      const morning = context?.memory?.recentTurns.find((turn) =>
        turn.userText.includes("квартальный отчёт"),
      );
      if (input.text.includes("Отчёт не успел") && morning) {
        return "Вижу: утром главным был квартальный отчёт, но день забрали звонки. Давай выделим следующий маленький шаг.";
      }
      return "Зафиксировал приоритет дня.";
    };

    const spec = createSpecWorld(mockAgentRunner);
    await onboardTestEmployee(spec, { persona: "efficiency" });

    await spec.cli.json<ChatResult>([
      "employee",
      "chat",
      "--employee",
      testEmployee.employeeId,
      "--thread",
      testEmployee.threadId,
      "--text",
      morningPlanText,
    ]);

    const evening = await spec.cli.json<ChatResult>([
      "employee",
      "chat",
      "--employee",
      testEmployee.employeeId,
      "--thread",
      testEmployee.threadId,
      "--text",
      eveningReflectionText,
    ]);

    expect(evening.response).toContain("квартальный отчёт");
    const eveningRun = observedRuns.find((run) =>
      run.input.text.includes("Отчёт не успел"),
    );
    expect(eveningRun?.context?.memory).toMatchObject({
      resourceId: testEmployee.employeeId,
      threadId: testEmployee.threadId,
    });
    expect(eveningRun?.context?.memory?.recentTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userText: expect.stringContaining("квартальный отчёт"),
          agentResponse: expect.stringContaining("приоритет"),
        }),
      ]),
    );

    expect(spec.world.messages).toHaveLength(2);
    expect(spec.world.messages.every((m) => m.threadId === testEmployee.threadId)).toBe(
      true,
    );

    const insights = await spec.cli.json<StructuredInsightResult[]>([
      "employee",
      "insights",
      "--employee",
      testEmployee.employeeId,
      "--thread",
      testEmployee.threadId,
    ]);

    expect(insights).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "routine_pattern",
          patternType: "meeting_overload",
          label: expect.stringContaining("звон"),
        }),
        expect.objectContaining({
          kind: "energy_stress_marker",
          marker: expect.stringMatching(/blocked_progress|overload|fatigue/),
        }),
        expect.objectContaining({
          kind: "task_category",
          category: expect.stringMatching(/reporting|meetings/),
        }),
      ]),
    );

    const eveningMessageId = evening.messageId;
    for (const insight of insights) {
      expect(insight.sourceMessageId).toBeTruthy();
      expect(JSON.stringify(insight)).not.toContain(morningPlanText);
      expect(JSON.stringify(insight)).not.toContain(eveningReflectionText);
    }
    expect(
      insights.some((insight) => insight.sourceMessageId === eveningMessageId),
    ).toBe(true);

    expectEvent(spec, [
      { type: "ChatMessageReceived", employeeId: testEmployee.employeeId },
      { type: "ChatResponseGenerated", employeeId: testEmployee.employeeId },
      { type: "InsightRecorded", employeeId: testEmployee.employeeId },
    ]);
  });
});
