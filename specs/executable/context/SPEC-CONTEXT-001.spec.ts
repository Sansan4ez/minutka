import { describe, expect, it } from "vitest";
import type {
  AgentRunContext,
  AgentRunner,
  ChatInput,
  ChatResult,
} from "../../../src/application/minutka-service.js";
import type { StructuredInsightResult } from "../../../src/client/sdk/minutka-client.js";
import { createConversationDecisionRouter } from "../../../src/mastra/conversation-decision-router.js";
import { createInsightExtractor } from "../../../src/mastra/insight-extractor.js";
import { createMinutkaAgentRunner } from "../../../src/mastra/agent-runner.js";
import { loadAgentManualFromDisk } from "../../../src/application/agent-manual-loader.js";
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
    "extractInsightsTool",
    "runMinutkaAgent",
    "routeAgentManualProcesses",
    "routeConversationDecision",
    "extractInsightsWithAgent",
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
    const { extractInsightsTool } = await import(
      "../../../src/mastra/tools/extract-insights-tool.js"
    );
    const { runMinutkaAgent } = await import(
      "../../../src/mastra/agent-runner.js"
    );
    const { routeAgentManualProcesses } = await import(
      "../../../src/mastra/agent-manual-router.js"
    );
    const { routeConversationDecision } = await import(
      "../../../src/mastra/conversation-decision-router.js"
    );
    const { extractInsightsWithAgent } = await import(
      "../../../src/mastra/insight-extractor.js"
    );

    expect(minutkaAgent).toBeDefined();
    expect(extractInsightsTool).toBeDefined();
    expect(runMinutkaAgent).toBeDefined();
    expect(routeAgentManualProcesses).toBeDefined();
    expect(routeConversationDecision).toBeDefined();
    expect(extractInsightsWithAgent).toBeDefined();
  });

  it("passes rendered context to the runtime agent without Mastra message memory", async () => {
    let observedOptions: unknown;
    const runner = createMinutkaAgentRunner({
      async generate(_text, options) {
        observedOptions = options;
        return { text: "ok" };
      },
    });

    await expect(
      runner(
        { employeeId: "emp_1", threadId: "thread_1", text: "Привет" },
        {
          purpose: "chat",
          systemContext: "trusted runtime context",
        },
      ),
    ).resolves.toBe("ok");
    expect(observedOptions).toEqual({
      system: "trusted runtime context",
      toolChoice: "none",
    });
  });

  it("normalizes a valid flat structured decision into the domain decision", async () => {
    const router = createConversationDecisionRouter(async () => ({
      object: {
        selectedProcessIds: ["core"],
        workDecision: {
          mode: "allow",
          reason: "workday_reflection",
          response: null,
        },
        insightDecision: { candidate: false, suggestedKinds: [] },
      },
    }));

    await expect(
      router({
        purpose: "chat",
        text: "Сегодня много встреч.",
        manual: loadAgentManualFromDisk(),
      }),
    ).resolves.toEqual({
      selectedProcessIds: ["core"],
      workDecision: { mode: "allow", reason: "workday_reflection" },
      insightDecision: { candidate: false, suggestedKinds: [] },
    });
  });

  it("rejects a malformed structured decision before it reaches the application", async () => {
    const router = createConversationDecisionRouter(async () => ({
      object: {
        selectedProcessIds: ["core"],
        workDecision: {
          mode: "allow",
          reason: "workday_reflection",
          response: null,
        },
        insightDecision: { candidate: true, suggestedKinds: ["not_an_insight_kind"] },
      },
    }));

    await expect(
      router({
        purpose: "chat",
        text: "Сегодня много встреч.",
        manual: loadAgentManualFromDisk(),
      }),
    ).rejects.toThrow(/structured output validation failed/);
  });

  it("normalizes provider-safe insight transport into a typed insight", async () => {
    const extractor = createInsightExtractor(async () => ({
      object: {
        insights: [
          {
            kind: "task_category",
            label: "отчёт",
            confidence: "high",
            category: "reporting",
            patternType: null,
            interferesWith: null,
            marker: null,
            intensity: null,
            candidateType: null,
            rationale: null,
          },
        ],
      },
    }));

    await expect(
      extractor({
        employeeId: "emp_1",
        threadId: "thread_1",
        messageId: "msg_1",
        text: "Нужно закончить отчёт.",
        response: "Давай выделим на него время.",
        recentTurns: [],
        decision: {
          selectedProcessIds: ["core", "insight_extraction"],
          workDecision: { mode: "allow", reason: "workday_reflection" },
          insightDecision: { candidate: true, suggestedKinds: ["task_category"] },
        },
      }),
    ).resolves.toEqual({
      insights: [
        expect.objectContaining({
          kind: "task_category",
          category: "reporting",
          employeeId: "emp_1",
          threadId: "thread_1",
          sourceMessageId: "msg_1",
        }),
      ],
    });
  });

  it("rejects malformed insight transport before it reaches the application", async () => {
    const extractor = createInsightExtractor(async () => ({
      object: { insights: [{ kind: "task_category", confidence: "certain" }] },
    }));

    await expect(
      extractor({
        employeeId: "emp_1",
        threadId: "thread_1",
        messageId: "msg_1",
        text: "Нужно закончить отчёт.",
        response: "Давай выделим на него время.",
        recentTurns: [],
        decision: {
          selectedProcessIds: ["core", "insight_extraction"],
          workDecision: { mode: "allow", reason: "workday_reflection" },
          insightDecision: { candidate: true, suggestedKinds: ["task_category"] },
        },
      }),
    ).rejects.toThrow(/structured output validation failed/);
  });

  it("uses morning plan in evening reflection and records privacy-safe insights", async () => {
    const observedRuns: Array<{ input: ChatInput; context?: AgentRunContext }> = [];
    const mockAgentRunner: AgentRunner = async (input, context) => {
      observedRuns.push({ input, context });
      const morning = context?.systemContext?.includes("квартальный отчёт");
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
    expect(eveningRun?.context?.systemContext).toContain("untrusted conversation data");
    expect(eveningRun?.context?.systemContext).toContain("квартальный отчёт");

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
