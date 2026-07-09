import { describe, expect, it } from "vitest";
import { loadAgentManualFromDisk } from "../../../src/application/agent-manual-loader.js";
import type { AgentManualRouter } from "../../../src/application/agent-manual-resolver.js";
import { buildMinutkaContext } from "../../../src/application/minutka-context-builder.js";
import type {
  AgentRunContext,
  AgentRunner,
  ChatInput,
  ChatResult,
} from "../../../src/application/minutka-service.js";
import {
  createSpecWorld,
  expectEvent,
  registerSpecMetadata,
} from "../support/spec-harness.js";
import {
  eveningReflectionText,
  morningPlanText,
  outOfScopePostRequest,
  testEmployee,
} from "../support/fixtures.js";
import { onboardTestEmployee } from "../support/onboarding-helper.js";

registerSpecMetadata({
  id: "SPEC-PROCESS-ROUTING-001",
  userStory: "US-PROCESS-ROUTING-001",
  requirements: [
    "FR-PROCESS-ROUTING-001",
    "FR-CONTEXT-001",
    "FR-GUARDRAILS-001",
  ],
  productParts: ["ai-agent-backend-runtime"],
  contracts: ["chat", "completeOnboarding", "contextBuilder", "submitFeedback"],
  events: ["ChatMessageReceived", "WorkBoundaryApplied", "ChatResponseGenerated", "FeedbackReceived"],
  mastra: [],
  cli: [
    "employee open-invite",
    "employee accept-consent",
    "employee complete-onboarding",
    "employee chat",
    "employee feedback",
  ],
});

const noOptionalProcessRouter: AgentManualRouter = async () => [];

const eveningReflectionRouter: AgentManualRouter = async (input) =>
  input.text === eveningReflectionText ? ["evening_reflection"] : [];

describe("SPEC-PROCESS-ROUTING-001: constrained Agent Vault router selects processes", () => {
  it("selects core, onboarding and privacy for onboarding first response", async () => {
    const observedRuns: Array<{ input: ChatInput; context?: AgentRunContext }> = [];
    const mockAgentRunner: AgentRunner = async (input, context) => {
      observedRuns.push({ input, context });
      return "Принято. Начнём с главного приоритета на сегодня.";
    };

    const spec = createSpecWorld(mockAgentRunner);
    await onboardTestEmployee(spec);

    const onboardingRun = observedRuns.find(
      (run) => run.context?.purpose === "onboarding_first_response",
    );
    expect(onboardingRun?.context?.selectedProcessIds).toEqual(
      expect.arrayContaining(["core", "onboarding", "consent_and_privacy"]),
    );
    expect(onboardingRun?.context?.systemContext).toContain(
      "## Agent Vault process: onboarding",
    );
  });

  it("selects evening reflection and insight extraction for evening chat", async () => {
    const observedRuns: Array<{ input: ChatInput; context?: AgentRunContext }> = [];
    const mockAgentRunner: AgentRunner = async (input, context) => {
      observedRuns.push({ input, context });
      return input.text.includes("Отчёт не успел")
        ? "Вижу: утром главным был квартальный отчёт, но день забрали звонки."
        : "Зафиксировал приоритет дня.";
    };

    const spec = createSpecWorld(mockAgentRunner, {
      deps: { agentManualRouter: eveningReflectionRouter },
    });
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

    expect(evening.selectedProcessIds).toEqual(
      expect.arrayContaining(["core", "evening_reflection", "insight_extraction"]),
    );
    const eveningRun = observedRuns.find((run) =>
      run.input.text.includes("Отчёт не успел"),
    );
    expect(eveningRun?.context?.selectedProcessIds).toEqual(
      expect.arrayContaining(["core", "evening_reflection", "insight_extraction"]),
    );
  });

  it("audits guardrail process for blocked chat without insight extraction", async () => {
    let chatCalls = 0;
    const spec = createSpecWorld(
      async (_input, context) => {
        if (context?.purpose === "chat") chatCalls++;
        return "ok";
      },
      { deps: { agentManualRouter: noOptionalProcessRouter } },
    );
    await onboardTestEmployee(spec);

    const result = await spec.cli.json<ChatResult>([
      "employee",
      "chat",
      "--employee",
      testEmployee.employeeId,
      "--thread",
      "thread_process_guardrail",
      "--text",
      outOfScopePostRequest,
    ]);

    expect(chatCalls).toBe(0);
    expect(result.selectedProcessIds).toEqual(
      expect.arrayContaining(["core", "workday_guardrails"]),
    );
    expect(result.selectedProcessIds).not.toContain("insight_extraction");
    expect(spec.world.insights).toEqual([]);
    expect(
      spec.world.events.find((event) => event.type === "WorkBoundaryApplied"),
    ).toMatchObject({
      selectedProcessIds: expect.arrayContaining(["core", "workday_guardrails"]),
    });
  });

  it("does not route ordinary work data messages when constrained router returns no optional processes", async () => {
    const manual = loadAgentManualFromDisk();
    const built = await buildMinutkaContext(
      {
        purpose: "chat",
        text: "Нужно подготовить данные по продажам за квартал.",
      },
      { manual, router: noOptionalProcessRouter },
    );

    expect(built.selectedProcessIds).toEqual(["core"]);
  });

  it("routes privacy questions through constrained router, independent of request language", async () => {
    const manual = loadAgentManualFromDisk();
    let observedPrompt = "";
    const privacyRouter: AgentManualRouter = async (input) => {
      observedPrompt = input.routingPrompt;
      expect(input.candidateProcessIds).toContain("consent_and_privacy");
      return ["consent_and_privacy"];
    };

    const built = await buildMinutkaContext(
      {
        purpose: "chat",
        text: "What data can my company see?",
      },
      { manual, router: privacyRouter },
    );

    expect(observedPrompt).toContain("# Process index");
    expect(observedPrompt).toContain("consent_and_privacy");
    expect(built.selectedProcessIds).toEqual(
      expect.arrayContaining(["core", "consent_and_privacy"]),
    );
  });

  it("does not route morning planning text as evening reflection when router does not select it", async () => {
    const manual = loadAgentManualFromDisk();
    const built = await buildMinutkaContext(
      {
        purpose: "chat",
        text: "Сегодня в плане три встречи с клиентами.",
        selectedProcessIds: ["core", "insight_extraction"],
        recentTurns: [
          {
            messageId: "msg_morning_plan",
            employeeId: testEmployee.employeeId,
            threadId: testEmployee.threadId,
            userText: morningPlanText,
            agentResponse: "Зафиксировал приоритет дня.",
            timestamp: "2026-07-08T09:00:00.000Z",
          },
        ],
      },
      { manual, router: noOptionalProcessRouter },
    );

    expect(built.selectedProcessIds).toEqual(
      expect.arrayContaining(["core", "insight_extraction"]),
    );
    expect(built.selectedProcessIds).not.toContain("evening_reflection");
  });

  it("routes feedback through the service boundary", async () => {
    const spec = createSpecWorld(async () => "ok", {
      deps: { agentManualRouter: noOptionalProcessRouter },
    });
    await onboardTestEmployee(spec);

    const result = await spec.cli.json<{
      accepted: true;
      selectedProcessIds: string[];
    }>([
      "employee",
      "feedback",
      "--employee",
      testEmployee.employeeId,
      "--thread",
      testEmployee.threadId,
      "--text",
      "👍",
    ]);

    expect(result).toMatchObject({ accepted: true });
    expect(result.selectedProcessIds).toEqual(["core", "feedback"]);
    expectEvent(spec, {
      type: "FeedbackReceived",
      employeeId: testEmployee.employeeId,
      threadId: testEmployee.threadId,
      text: "👍",
      selectedProcessIds: ["core", "feedback"],
    });
  });
});
