import { describe, expect, it } from "vitest";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { extractDeterministicOnboardingPatch } from "../../../src/application/onboarding-profile-extractor.js";

async function consentedRuntime(employeeId = "emp_conversational") {
  const world = createInMemoryWorld();
  const runtime = createInMemoryRuntime({ world, agentRunner: async () => "Добро пожаловать!" });
  await runtime.service.issueInvite({ employeeId, inviteCode: `invite_${employeeId}` });
  await runtime.service.openInvite({ inviteCode: `invite_${employeeId}` });
  await runtime.service.acceptConsent({ employeeId, accepted: true, source: "test" });
  return runtime;
}

const completeAnswer = "Максим | Спарк | На ты | Деловой | Коротко | Europe/Moscow";

describe("SPEC-CONVERSATIONAL-ONBOARDING-001: minimal personal introduction", () => {
  it("collects the minimal profile in one message and writes only after confirmation", async () => {
    const runtime = await consentedRuntime();
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: completeAnswer })).toMatchObject({
      status: "needs_confirmation",
      summary: { preferredName: "Максим", assistantName: "Спарк", addressForm: "на ты", persona: "деловой", responseLength: "коротко", timezone: "Europe/Moscow" },
    });
    expect(runtime.world.profiles).toHaveLength(0);
    await runtime.service.confirmOnboarding({ employeeId: "emp_conversational" });
    expect(runtime.world.profiles[0]).toMatchObject({ preferredName: "Максим", assistantName: "Спарк", addressForm: "informal", persona: "efficiency", responseLength: "short", timezone: "Europe/Moscow" });
    expect(runtime.world.profiles[0].role).toBeUndefined();
    expect(runtime.world.profiles[0].typicalTasks).toBeUndefined();
    expect(runtime.world.profiles[0].aiLevel).toBeUndefined();
    expect(runtime.world.onboardingDrafts).toHaveLength(0);
  });

  it("asks at most one next question and accepts partial answers", async () => {
    const runtime = await consentedRuntime();
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Максим" })).toMatchObject({ status: "needs_answer", field: "assistantName" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Спарк" })).toMatchObject({ status: "needs_choice", field: "addressForm" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "informal" })).toMatchObject({ status: "needs_choice", field: "persona" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "efficiency" })).toMatchObject({ status: "needs_choice", field: "responseLength" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "short" })).toMatchObject({ status: "needs_answer", field: "timezone" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Europe/Moscow" })).toMatchObject({ status: "needs_confirmation" });
  });

  it("does not overwrite collected values before confirmation and accepts explicit corrections after the summary", async () => {
    const runtime = await consentedRuntime();
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Максим" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Алексей" });
    expect(runtime.world.onboardingDrafts[0].preferredName).toBe("Максим");

    await runtime.service.resetOnboardingDraft({ employeeId: "emp_conversational" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: completeAnswer });
    await expect(runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Нет" })).resolves.toMatchObject({ status: "needs_correction" });
    await expect(runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Зови меня Алексей" })).resolves.toMatchObject({
      status: "needs_confirmation", summary: { preferredName: "Алексей", assistantName: "Спарк" },
    });
  });

  it("validates IANA timezone and falls back deterministically when the extractor fails", async () => {
    const invalid = await consentedRuntime("emp_invalid_tz");
    await invalid.service.submitOnboardingAnswer({ employeeId: "emp_invalid_tz", text: "Максим | Спарк | На ты | Деловой | Коротко | Moscow" });
    expect(invalid.world.onboardingDrafts[0].timezone).toBeUndefined();
    expect(invalid.world.onboardingDrafts[0].pendingField).toBe("timezone");

    const world = createInMemoryWorld();
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok", deps: { onboardingProfileExtractor: async () => { throw new Error("provider unavailable"); } } });
    await runtime.service.issueInvite({ employeeId: "emp_fallback", inviteCode: "invite_fallback" });
    await runtime.service.openInvite({ inviteCode: "invite_fallback" });
    await runtime.service.acceptConsent({ employeeId: "emp_fallback", accepted: true, source: "test" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_fallback", text: completeAnswer })).toMatchObject({ status: "needs_confirmation" });
  });

  it("makes repeated confirmation idempotent without duplicate audit facts or agent runs", async () => {
    let agentRuns = 0;
    const world = createInMemoryWorld();
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => { agentRuns += 1; return "ok"; } });
    await runtime.service.issueInvite({ employeeId: "emp_confirm", inviteCode: "invite_confirm" });
    await runtime.service.openInvite({ inviteCode: "invite_confirm" });
    await runtime.service.acceptConsent({ employeeId: "emp_confirm", accepted: true, source: "test" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_confirm", text: completeAnswer });
    await Promise.all([runtime.service.confirmOnboarding({ employeeId: "emp_confirm" }), runtime.service.confirmOnboarding({ employeeId: "emp_confirm" })]);
    expect(agentRuns).toBe(1);
    expect(world.auditEvents.filter((event) => event.type === "profile_updated")).toHaveLength(1);
    expect(world.auditEvents.filter((event) => event.type === "onboarding_completed")).toHaveLength(1);
  });

  it("does not recreate a draft when confirmation completes during extraction", async () => {
    let extractionStarted!: () => void;
    let releaseExtraction!: () => void;
    const started = new Promise<void>((resolve) => { extractionStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseExtraction = resolve; });
    const world = createInMemoryWorld();
    const runtime = createInMemoryRuntime({
      world,
      agentRunner: async () => "ok",
      deps: { onboardingProfileExtractor: async (input) => { if (input.text === "Зови меня Алексей") { extractionStarted(); await release; } return extractDeterministicOnboardingPatch(input); } },
    });
    await runtime.service.issueInvite({ employeeId: "emp_race", inviteCode: "invite_race" });
    await runtime.service.openInvite({ inviteCode: "invite_race" });
    await runtime.service.acceptConsent({ employeeId: "emp_race", accepted: true, source: "test" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_race", text: completeAnswer });
    const staleAnswer = runtime.service.submitOnboardingAnswer({ employeeId: "emp_race", text: "Зови меня Алексей" });
    await started;
    await runtime.service.confirmOnboarding({ employeeId: "emp_race" });
    releaseExtraction();
    await expect(staleAnswer).rejects.toMatchObject({ code: "profile_already_completed" });
    expect(world.onboardingDrafts).toHaveLength(0);
  });
});
