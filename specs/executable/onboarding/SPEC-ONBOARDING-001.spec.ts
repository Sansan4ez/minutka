import { describe, expect, it } from "vitest";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import {
  MinutkaService,
  type AgentRunContext,
  type AgentRunner,
  type ChatInput,
} from "../../../src/application/minutka-service.js";
import type { UserProfile } from "../../../src/domain/employee.js";
import type {
  AcceptConsentResult,
  CompleteOnboardingResult,
  OpenInviteResult,
} from "../../../src/client/sdk/minutka-client.js";
import {
  createSpecWorld,
  expectEvent,
  expectProfile,
  registerSpecMetadata,
} from "../support/spec-harness.js";
import { testEmployee, testInvite, testProfile } from "../support/fixtures.js";

registerSpecMetadata({
  id: "SPEC-ONBOARDING-001",
  userStory: "US-ONBOARDING-001",
  requirements: ["FR-ONBOARDING-001", "FR-CONSENT-001", "FR-PROFILE-001"],
  productParts: [
    "telegram-bot-shell",
    "ai-agent-backend-runtime",
    "data-storage-and-privacy-layer",
  ],
  contracts: ["openInvite", "acceptConsent", "completeOnboarding", "profile", "chat"],
  events: [
    "InviteOpened",
    "PrivacyExplanationShown",
    "ConsentAccepted",
    "UserProfileUpdated",
    "OnboardingCompleted",
    "ChatMessageReceived",
    "ChatResponseGenerated",
  ],
  mastra: ["minutkaAgent", "updateProfileTool"],
  cli: [
    "employee open-invite",
    "employee accept-consent",
    "employee complete-onboarding",
    "employee profile",
    "employee chat",
  ],
});

describe("SPEC-ONBOARDING-001: onboarding consent and profile context", () => {
  it("Mastra updateProfileTool is importable and agent smoke stays green", async () => {
    const { updateProfileTool } = await import(
      "../../../src/mastra/tools/update-profile-tool.js"
    );
    const { minutkaAgent } = await import(
      "../../../src/mastra/agents/minutka-agent.js"
    );

    expect(updateProfileTool).toBeDefined();
    expect(minutkaAgent).toBeDefined();
    expect(minutkaAgent.name).toBe("Минутка");
  });

  it("onboards employee with consent, profile and efficiency persona context", async () => {
    const observedRuns: Array<{ input: ChatInput; context?: AgentRunContext }> = [];
    const mockAgentRunner: AgentRunner = async (input, context) => {
      observedRuns.push({ input, context });
      if (context?.systemContext?.includes("Эффективность")) {
        return "Принято. Зафиксировал роль и задачи. Начнём с главного приоритета на сегодня.";
      }
      return "Принято.";
    };

    const spec = createSpecWorld(mockAgentRunner);

    const invite = await spec.cli.json<OpenInviteResult>([
      "employee",
      "open-invite",
      "--invite",
      testInvite.inviteCode,
      "--employee",
      testEmployee.employeeId,
    ]);

    expect(invite.employeeId).toBe(testEmployee.employeeId);
    expect(invite.status).toBe("invite_opened");
    expect(invite.privacyExplanation).toContain("личные диалоги");
    expect(invite.privacyExplanation).toContain("обезлич");
    expect(invite.privacyExplanation).toContain("5 сотрудников");

    const consent = await spec.cli.json<AcceptConsentResult>([
      "employee",
      "accept-consent",
      "--employee",
      testEmployee.employeeId,
      "--yes",
    ]);

    expect(consent.privacyVersion).toBe("privacy-v1");
    expect(spec.world.consents).toHaveLength(1);

    const onboarding = await spec.cli.json<CompleteOnboardingResult>([
      "employee",
      "complete-onboarding",
      "--employee",
      testEmployee.employeeId,
      "--role",
      testProfile.role,
      "--task",
      "встречи",
      "--task",
      "отчёты",
      "--task",
      "координация подрядчиков",
      "--persona",
      "efficiency",
      "--ai-level",
      "intermediate",
      "--response-length",
      "short",
    ]);

    expect(onboarding.profile.persona).toBe("efficiency");
    expect(onboarding.profile.aiLevel).toBe("intermediate");
    expect(onboarding.firstResponse).toContain("приоритет");
    expectProfile(spec, testEmployee.employeeId, {
      role: testProfile.role,
      typicalTasks: testProfile.typicalTasks,
      persona: "efficiency",
      aiLevel: "intermediate",
      responseLength: "short",
    });

    const profile = await spec.cli.json<UserProfile>([
      "employee",
      "profile",
      "--employee",
      testEmployee.employeeId,
    ]);

    expect(profile.role).toBe(testProfile.role);
    expect(profile.typicalTasks).toEqual(testProfile.typicalTasks);

    await spec.cli.json([
      "employee",
      "chat",
      "--employee",
      testEmployee.employeeId,
      "--thread",
      testEmployee.threadId,
      "--text",
      "Сегодня хочу закрыть отчёт и не утонуть во встречах.",
    ]);

    expect(
      observedRuns.some(
        (run) =>
          run.context?.purpose === "onboarding_first_response" &&
          run.context.systemContext?.includes("Эффективность") &&
          run.context.systemContext.includes(testProfile.role) &&
          run.context.systemContext.includes("intermediate") &&
          run.context.systemContext.includes("практический шаг"),
      ),
    ).toBe(true);

    expect(
      observedRuns.some(
        (run) =>
          run.context?.purpose === "chat" &&
          run.context.systemContext?.includes("Эффективность") &&
          run.context.profile?.employeeId === testEmployee.employeeId,
      ),
    ).toBe(true);

    expectEvent(spec, [
      { type: "InviteOpened", employeeId: testEmployee.employeeId },
      { type: "PrivacyExplanationShown", employeeId: testEmployee.employeeId },
      { type: "ConsentAccepted", employeeId: testEmployee.employeeId },
      { type: "UserProfileUpdated", employeeId: testEmployee.employeeId },
      { type: "OnboardingCompleted", employeeId: testEmployee.employeeId },
      { type: "ChatMessageReceived", employeeId: testEmployee.employeeId },
      { type: "ChatResponseGenerated", employeeId: testEmployee.employeeId },
    ]);

    const reopened = await spec.cli.json<OpenInviteResult>([
      "employee",
      "open-invite",
      "--invite",
      testInvite.inviteCode,
      "--employee",
      testEmployee.employeeId,
    ]);

    expect(reopened.status).toBe("profile_completed");
    expect(spec.world.participants).toHaveLength(1);
    expect(spec.world.events.filter((e) => e.type === "InviteOpened")).toHaveLength(1);

    const acceptedAgain = await spec.cli.json<AcceptConsentResult>([
      "employee",
      "accept-consent",
      "--employee",
      testEmployee.employeeId,
      "--yes",
    ]);

    expect(acceptedAgain.acceptedAt).toBe(consent.acceptedAt);
    expect(spec.world.consents).toHaveLength(1);
    expect(spec.world.events.filter((e) => e.type === "ConsentAccepted")).toHaveLength(1);
  });

  it("blocks onboarding without consent", async () => {
    const spec = createSpecWorld(async () => "ok");

    await spec.cli.json([
      "employee",
      "open-invite",
      "--invite",
      "invite_no_consent",
      "--employee",
      "emp_no_consent",
    ]);

    await expect(
      spec.cli.json([
        "employee",
        "complete-onboarding",
        "--employee",
        "emp_no_consent",
        "--role",
        testProfile.role,
        "--task",
        "встречи",
        "--persona",
        "efficiency",
        "--ai-level",
        "intermediate",
      ]),
    ).rejects.toThrow(/consent/i);
  });

  it("rejects unknown persona before application layer", async () => {
    const spec = createSpecWorld(async () => "ok");

    const result = await spec.cli.run([
      "employee",
      "complete-onboarding",
      "--employee",
      testEmployee.employeeId,
      "--role",
      testProfile.role,
      "--task",
      "встречи",
      "--persona",
      "harsh",
      "--ai-level",
      "intermediate",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toMatch(/persona/i);
  });

  it("does not accept consent without --yes", async () => {
    const spec = createSpecWorld(async () => "ok");

    await spec.cli.json([
      "employee",
      "open-invite",
      "--invite",
      "invite_consent_no_yes",
      "--employee",
      "emp_consent_no_yes",
    ]);

    const result = await spec.cli.run([
      "employee",
      "accept-consent",
      "--employee",
      "emp_consent_no_yes",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join("\n")).toMatch(/explicitly accepted/i);
    expect(spec.world.consents).toHaveLength(0);
  });

  it("keeps consent explanation timestamp and first profile changedFields precise", async () => {
    const timestamps = [
      "2026-07-08T10:00:00.000Z",
      "2026-07-08T10:01:00.000Z",
      "2026-07-08T10:02:00.000Z",
      "2026-07-08T10:03:00.000Z",
    ];
    let index = 0;
    const world = createInMemoryWorld(() => timestamps[index++] ?? timestamps.at(-1)!);
    const service = new MinutkaService(world, async () => "first response");

    await service.issueInvite({
      inviteCode: "invite_timestamp",
      employeeId: "emp_timestamp",
    });
    await service.openInvite({ inviteCode: "invite_timestamp" });
    await service.acceptConsent({
      employeeId: "emp_timestamp",
      accepted: true,
      source: "test",
    });
    await service.completeOnboarding({
      employeeId: "emp_timestamp",
      role: testProfile.role,
      typicalTasks: ["встречи"],
      persona: "support",
      aiLevel: "beginner",
    });

    expect(world.consents[0]).toMatchObject({
      acceptedAt: "2026-07-08T10:03:00.000Z",
      explanationShownAt: "2026-07-08T10:02:00.000Z",
    });
    expect(
      world.events.find((event) => event.type === "UserProfileUpdated"),
    ).toMatchObject({
      changedFields: [
        "role",
        "typicalTasks",
        "persona",
        "aiLevel",
        "responseLength",
      ],
    });
  });

  it("rejects reopening invite for another employee", async () => {
    const spec = createSpecWorld(async () => "ok");

    await spec.cli.json([
      "employee",
      "issue-invite",
      "--invite",
      "invite_busy",
      "--employee",
      "emp_owner",
    ]);

    await expect(
      spec.cli.json([
        "employee",
        "issue-invite",
        "--invite",
        "invite_busy",
        "--employee",
        "emp_other",
      ]),
    ).rejects.toThrow(/invite already belongs to another employee/);
  });
});
