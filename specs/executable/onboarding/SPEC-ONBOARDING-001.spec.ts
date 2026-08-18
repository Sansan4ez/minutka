import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import {
  type AgentRunContext,
  type AgentRunner,
  type ChatInput,
} from "../../../src/application/minutka-service.js";
import type { UserProfile } from "../../../src/domain/employee.js";
import { currentPrivacyVersion } from "../../../src/domain/privacy.js";
import { executableSpecPrivacyPolicyUrl } from "../../../src/runtime/create-in-memory-runtime.js";
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
import { testEmployee, testInvite, testProfile, testTenant } from "../support/fixtures.js";
import { createOnboardingWelcome } from "../../../src/application/onboarding-welcome-loader.js";
import { createPrivacyExplanation } from "../../../src/application/consent-process-loader.js";

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
  mastra: ["onboardingProfileExtractorAgent"],
  cli: [
    "employee open-invite",
    "employee accept-consent",
    "employee complete-onboarding",
    "employee profile",
    "employee chat",
  ],
});

describe("SPEC-ONBOARDING-001: onboarding consent and profile context", () => {
  it("keeps only the bounded onboarding extractor agent importable", async () => {
    const { onboardingProfileExtractorAgent } = await import(
      "../../../src/mastra/agents/onboarding-profile-extractor-agent.js"
    );

    expect(onboardingProfileExtractorAgent).toBeDefined();
  });

  it("onboards employee with consent, deterministic welcome and efficiency persona context", async () => {
    const observedRuns: Array<{ input: ChatInput; context?: AgentRunContext }> = [];
    const mockAgentRunner: AgentRunner = async (input, context) => {
      observedRuns.push({ input, context });
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
    expect(invite.privacyVersion).toBe(currentPrivacyVersion);
    expect(invite.privacyExplanation).toContain("за пару минут");
    expect(invite.privacyExplanation).toContain("личном контуре");
    expect(invite.privacyExplanation).toContain("должность, категория активности, примерная длительность, система и дата");
    expect(invite.privacyExplanation).toContain("Методолог видит обезличенные записи");
    expect(invite.privacyExplanation).toContain("Компания получает срезы только от 5 участников");
    expect(invite.privacyExplanation).toContain("LLM-провайдеру");
    expect(invite.privacyExplanation).toContain("голос — сервису расшифровки");
    expect(invite.privacyExplanation).toContain("Личные данные удаляются через оператора");
    expect(invite.privacyExplanation).toContain("живут до отчёта");
    expect(invite.privacyExplanation).toContain("точечно их не ищем и не пересчитываем");
    expect(invite.privacyExplanation).toContain(executableSpecPrivacyPolicyUrl);
    expect(invite.privacyExplanation.length).toBeLessThanOrEqual(1_000);
    expect(invite.privacyExplanation).not.toMatch(/компания и методолог видят только агрегаты от пяти человек/i);
    expect(invite.privacyExplanation).not.toMatch(/вы видите все свои данные/i);
    expect(invite.privacyExplanation).not.toMatch(/(?:точечно|отдельн\w*)[^.\n]{0,80}удал/iu);

    const consent = await spec.cli.json<AcceptConsentResult>([
      "employee",
      "accept-consent",
      "--employee",
      testEmployee.employeeId,
      "--yes",
    ]);

    expect(consent.privacyVersion).toBe(currentPrivacyVersion);
    expect(spec.world.consents).toHaveLength(1);

    const onboarding = await spec.cli.json<CompleteOnboardingResult>([
      "employee",
      "complete-onboarding",
      "--employee",
      testEmployee.employeeId,
      "--role",
      testProfile.selfDescription,
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
    expect(onboarding.profile.aiLevel).toBeUndefined();
    expect(onboarding.firstResponse).toContain("я «Минутка»");
    expect(onboarding.firstResponse).toContain("записать 1–3 активности");
    expect(onboarding.firstResponse).toContain("не пишу за вас письма, отчёты и презентации");
    expect(onboarding.firstResponse).toContain("не оцениваю продуктивность");
    expect(onboarding.firstResponse).toContain("не докладываю руководителю");
    expect(onboarding.firstResponse).toContain("утреннее касание — в 08:30");
    expect(onboarding.firstResponse).toContain("вечернее — в 19:00");
    expect(onboarding.firstResponse).not.toMatch(/недель|персональн(?:ый|ого) отч[её]т|раздел «Я»/iu);
    expect(onboarding.firstResponse).not.toMatch(/молодец|отлично|хорошая работа/iu);
    expect(onboarding.firstActivityPrompt).toBe("Чем вы сегодня занимались? Достаточно пары строк.");
    expectProfile(spec, testEmployee.employeeId, {
      role: testProfile.selfDescription,
      persona: "efficiency",
      responseLength: "short",
    });

    const profile = await spec.cli.json<UserProfile>([
      "employee",
      "profile",
      "--employee",
      testEmployee.employeeId,
    ]);

    expect(profile.role).toBe(testProfile.selfDescription);
    expect(profile.typicalTasks).toBeUndefined();

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

    expect(observedRuns.some((run) => run.context?.purpose === "onboarding_first_response")).toBe(false);

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
    expect(spec.world.participants[0]?.privacyExplanationShownAt).toBeDefined();
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

  it("rejects malformed welcome marker blocks and placeholder counts", () => {
    const schedules = [
      { kind: "process", processId: "morning_activity_collection", timeOfDay: "08:45" },
      { kind: "process", processId: "evening_reflection", timeOfDay: "18:30" },
    ] as Parameters<typeof createOnboardingWelcome>[1];
    const informalProfile = { preferredName: "Максим", addressForm: "informal" } as const;
    const formalProfile = { preferredName: "Алексей", addressForm: "formal" } as const;
    const writeWelcome = (content: string) => {
      const root = mkdtempSync(join(tmpdir(), "minutka-welcome-"));
      mkdirSync(join(root, "vault/assistant/texts"), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "vault/assistant/texts/onboarding_welcome.md"), content);
      return root;
    };

    expect(() => createOnboardingWelcome(informalProfile, schedules, { repoRoot: writeWelcome("{{preferredName}} {{morningTime}} {{eveningTime}}") })).toThrow(/one ordered/);
    expect(() => createOnboardingWelcome(informalProfile, schedules, { repoRoot: writeWelcome([
      "<!-- minutka-welcome:start -->",
      "{{preferredName}} {{preferredName}} {{morningTime}} {{eveningTime}}",
      "<!-- minutka-welcome:end -->",
    ].join("\n")) })).toThrow(/preferredName.*exactly once/);
    const welcomeRoot = writeWelcome([
      "<!-- minutka-welcome:start -->",
      "{{preferredName}}, утро {{morningTime}}, вечер {{eveningTime}}",
      "<!-- minutka-welcome:end -->",
    ].join("\n"));
    expect(createOnboardingWelcome(informalProfile, schedules, { repoRoot: welcomeRoot })).toBe("Максим, утро 08:45, вечер 18:30");
    expect(createOnboardingWelcome(formalProfile, schedules, { repoRoot: welcomeRoot })).toBe("Алексей, утро 08:45, вечер 18:30");
    expect(() => createOnboardingWelcome({ preferredName: "   " }, schedules, { repoRoot: welcomeRoot })).toThrow(/preferredName.*empty/);
  });

  it("requires both layered consent blocks and exactly one policy URL placeholder in each", () => {
    const writeConsent = (content: string) => {
      const root = mkdtempSync(join(tmpdir(), "minutka-consent-"));
      mkdirSync(join(root, "vault/assistant/processes"), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}");
      writeFileSync(join(root, "vault/assistant/processes/consent_and_privacy.md"), content);
      return root;
    };
    const valid = [
      "<!-- minutka-consent-short:start -->", "Коротко {{privacyPolicyUrl}}", "<!-- minutka-consent-short:end -->",
      "<!-- minutka-consent-full:start -->", "Полностью {{privacyPolicyUrl}}", "<!-- minutka-consent-full:end -->",
    ].join("\n");

    expect(createPrivacyExplanation("https://example.test/privacy-v5.html", { repoRoot: writeConsent(valid) })).toEqual({
      short: "Коротко https://example.test/privacy-v5.html",
      full: "Полностью https://example.test/privacy-v5.html",
    });
    expect(() => createPrivacyExplanation("https://example.test/privacy-v5.html", { repoRoot: writeConsent(valid.replace(/<!-- minutka-consent-short:[^>]+ -->\n?/gu, "")) })).toThrow(/consent-short/);
    expect(() => createPrivacyExplanation("https://example.test/privacy-v5.html", { repoRoot: writeConsent(valid.replace(/<!-- minutka-consent-full:[^>]+ -->\n?/gu, "")) })).toThrow(/consent-full/);
    expect(() => createPrivacyExplanation("https://example.test/privacy-v5.html", { repoRoot: writeConsent(valid.replace("Коротко {{privacyPolicyUrl}}", "Коротко без ссылки")) })).toThrow(/short block.*exactly once/);
    expect(() => createPrivacyExplanation("https://example.test/privacy-v5.html", { repoRoot: writeConsent(valid.replace("Полностью {{privacyPolicyUrl}}", "{{privacyPolicyUrl}} {{privacyPolicyUrl}}")) })).toThrow(/full block.*exactly once/);
  });

  it("requires re-consent when the stored privacy version is stale", async () => {
    const spec = createSpecWorld(async () => "ok");
    await spec.cli.json([
      "employee",
      "open-invite",
      "--invite",
      testInvite.inviteCode,
      "--employee",
      testEmployee.employeeId,
    ]);
    spec.world.consents.push({
      employeeId: testEmployee.employeeId,
      privacyVersion: "privacy-v1",
      acceptedAt: "2026-07-01T00:00:00.000Z",
      explanationShownAt: "2026-07-01T00:00:00.000Z",
      source: "test",
    });

    await expect(spec.cli.json([
      "employee",
      "complete-onboarding",
      "--employee",
      testEmployee.employeeId,
      "--role",
      testProfile.selfDescription,
      "--task",
      "встречи",
      "--persona",
      "efficiency",
      "--ai-level",
      "intermediate",
    ])).rejects.toThrow(/consent/i);

    const consent = await spec.cli.json<AcceptConsentResult>([
      "employee",
      "accept-consent",
      "--employee",
      testEmployee.employeeId,
      "--yes",
    ]);
    expect(consent.privacyVersion).toBe(currentPrivacyVersion);
    expect(spec.world.consents).toEqual([
      expect.objectContaining({ privacyVersion: currentPrivacyVersion }),
    ]);
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
        testProfile.selfDescription,
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
      testProfile.selfDescription,
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
    const { service } = createInMemoryRuntime({ world, agentRunner: async () => "first response" });

    await service.issueInvite({
      inviteCode: "invite_timestamp",
      employeeId: "emp_timestamp",
      companyId: "default_company",
      groupId: "default_group",
    });
    await service.openInvite({ inviteCode: "invite_timestamp" });
    await service.acceptConsent({
      employeeId: "emp_timestamp",
      accepted: true,
      source: "test",
    });
    await service.completeOnboarding({
      employeeId: "emp_timestamp",
      roleId: testTenant.roleId,
      selfDescription: testProfile.selfDescription,
      persona: "support",
    });

    expect(world.consents[0]).toMatchObject({
      acceptedAt: "2026-07-08T10:03:00.000Z",
      explanationShownAt: "2026-07-08T10:02:00.000Z",
    });
    expect(
      world.events.find((event) => event.type === "UserProfileUpdated"),
    ).toMatchObject({
      changedFields: [
        "roleId",
        "preferredName",
        "assistantName",
        "addressForm",
        "persona",
        "responseLength",
        "timezone",
        "role",
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
