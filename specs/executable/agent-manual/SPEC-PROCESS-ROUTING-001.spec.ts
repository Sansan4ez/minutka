import { describe, expect, it } from "vitest";
import { loadAgentManualFromDisk } from "../../../src/application/agent-manual-loader.js";
import { buildMinutkaContext } from "../../../src/application/minutka-context-builder.js";
import type {
  AgentRunContext,
  AgentRunner,
  ChatInput,
  ChatResult,
} from "../../../src/application/minutka-service.js";
import {
  createSpecWorld,
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
  contracts: ["chat", "completeOnboarding", "contextBuilder"],
  events: ["ChatMessageReceived", "WorkBoundaryApplied", "ChatResponseGenerated"],
  mastra: [],
  cli: [
    "employee open-invite",
    "employee accept-consent",
    "employee complete-onboarding",
    "employee chat",
  ],
});

describe("SPEC-PROCESS-ROUTING-001: context resolver selects processes", () => {
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
      "## Agent Manual process: onboarding",
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
    const spec = createSpecWorld(async (_input, context) => {
      if (context?.purpose === "chat") chatCalls++;
      return "ok";
    });
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

  it("prepares feedback routing through resolver API", () => {
    const manual = loadAgentManualFromDisk();
    const built = buildMinutkaContext(
      { purpose: "feedback", text: "👍" },
      { manual },
    );

    expect(built.selectedProcessIds).toEqual(["core", "feedback"]);
    expect(built.systemContext).toContain("## Agent Manual process: feedback");
  });
});
