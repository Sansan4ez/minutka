import { describe, expect, it } from "vitest";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { extractDeterministicOnboardingPatch } from "../../../src/application/onboarding-profile-extractor.js";

async function consentedRuntime() {
  const world = createInMemoryWorld();
  const runtime = createInMemoryRuntime({ world, agentRunner: async () => "Добро пожаловать!" });
  await runtime.service.issueInvite({ employeeId: "emp_conversational", inviteCode: "invite_conversational" });
  await runtime.service.openInvite({ inviteCode: "invite_conversational" });
  await runtime.service.acceptConsent({ employeeId: "emp_conversational", accepted: true, source: "test" });
  return runtime;
}

describe("SPEC-CONVERSATIONAL-ONBOARDING-001: progressive profile onboarding", () => {
  it("collects natural Russian answers, renders a summary, and writes only after confirmation", async () => {
    const runtime = await consentedRuntime();
    const progress = await runtime.service.submitOnboardingAnswer({
      employeeId: "emp_conversational",
      text: "Роль — руководитель проектов. Задачи: планирование, встречи, координация подрядчиков. Хочу эффективность, с ИИ немного работал.",
    });
    expect(progress).toMatchObject({
      status: "needs_confirmation",
      summary: { role: "руководитель проектов", persona: "Эффективность", aiLevel: "средний" },
    });
    expect(runtime.world.profiles).toHaveLength(0);
    await runtime.service.confirmOnboarding({ employeeId: "emp_conversational" });
    expect(runtime.world.profiles).toHaveLength(1);
    expect(runtime.world.onboardingDrafts).toHaveLength(0);
  });

  it("asks only for the next missing field and accepts Russian enum answers", async () => {
    const runtime = await consentedRuntime();
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Роль — аналитик" })).toMatchObject({ status: "needs_answer", field: "typicalTasks" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "отчёты, встречи" })).toMatchObject({ status: "needs_choice", field: "persona" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Поддержка" })).toMatchObject({ status: "needs_choice", field: "aiLevel" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "новичок" })).toMatchObject({ status: "needs_confirmation" });
  });

  it("does not overwrite a draft with conflicting extracted data, but accepts an explicit correction after the summary", async () => {
    const runtime = await consentedRuntime();
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Роль — аналитик" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Роль — менеджер" });
    expect(runtime.world.onboardingDrafts[0].role).toBe("аналитик");

    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Задачи: отчёты. Поддержка. Начинающий." });
    expect(runtime.world.onboardingDrafts[0].typicalTasks).toEqual(["отчёты"]);
    await expect(runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Нет" })).resolves.toMatchObject({ status: "needs_correction" });
    await expect(runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Роль — менеджер" })).resolves.toMatchObject({
      status: "needs_confirmation", summary: { role: "менеджер", typicalTasks: ["отчёты"] },
    });
  });

  it("falls back to deterministic extraction when the configured extractor fails or times out", async () => {
    const world = createInMemoryWorld();
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok", deps: { onboardingProfileExtractor: async () => { throw new Error("provider unavailable"); } } });
    await runtime.service.issueInvite({ employeeId: "emp_fallback", inviteCode: "invite_fallback" });
    await runtime.service.openInvite({ inviteCode: "invite_fallback" });
    await runtime.service.acceptConsent({ employeeId: "emp_fallback", accepted: true, source: "test" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_fallback", text: "Роль — аналитик" })).toMatchObject({ status: "needs_answer", field: "typicalTasks" });

    const timedOut = await consentedRuntime();
    timedOut.service = createInMemoryRuntime({ world: timedOut.world, agentRunner: async () => "ok", deps: { onboardingExtractionTimeoutMs: 1, onboardingProfileExtractor: async () => new Promise(() => undefined) } }).service;
    expect(await timedOut.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Роль — аналитик" })).toMatchObject({ status: "needs_answer", field: "typicalTasks" });
  });

  it("resets an existing draft, preserves task additions, and recognizes all Russian AI labels", async () => {
    const runtime = await consentedRuntime();
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Аналитик | встречи | Поддержка | Средний" });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Добавь отчёты к задачам" })).toMatchObject({
      status: "needs_confirmation", summary: { typicalTasks: ["встречи", "отчёты"] },
    });
    expect(await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Да" })).toMatchObject({ status: "completed" });

    const resetRuntime = await consentedRuntime();
    await resetRuntime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Роль — аналитик" });
    await resetRuntime.service.resetOnboardingDraft({ employeeId: "emp_conversational" });
    expect(resetRuntime.world.onboardingDrafts[0]).toMatchObject({ status: "collecting", revision: 3, pendingField: "role" });

    const labels = ["Начинающий", "Средний", "Продвинутый"] as const;
    for (const [index, label] of labels.entries()) {
      const employeeId = `emp_label_${index}`;
      await runtime.service.issueInvite({ employeeId, inviteCode: `invite_label_${index}` });
      await runtime.service.openInvite({ inviteCode: `invite_label_${index}` });
      await runtime.service.acceptConsent({ employeeId, accepted: true, source: "test" });
      const progress = await runtime.service.submitOnboardingAnswer({ employeeId, text: `Аналитик | отчёты | Поддержка | ${label}` });
      expect(progress).toMatchObject({ status: "needs_confirmation" });
    }
  });

  it("makes repeated confirmation idempotent without duplicate audit facts or agent runs", async () => {
    let agentRuns = 0;
    const world = createInMemoryWorld();
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => { agentRuns += 1; return "ok"; } });
    await runtime.service.issueInvite({ employeeId: "emp_confirm", inviteCode: "invite_confirm" });
    await runtime.service.openInvite({ inviteCode: "invite_confirm" });
    await runtime.service.acceptConsent({ employeeId: "emp_confirm", accepted: true, source: "test" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_confirm", text: "Аналитик | отчёты | Поддержка | Начинающий" });
    await Promise.all([runtime.service.confirmOnboarding({ employeeId: "emp_confirm" }), runtime.service.confirmOnboarding({ employeeId: "emp_confirm" })]);
    expect(agentRuns).toBe(1);
    expect(world.auditEvents.filter((event) => event.type === "profile_updated")).toHaveLength(1);
    expect(world.auditEvents.filter((event) => event.type === "onboarding_completed")).toHaveLength(1);
  });

  it("audits an explicit update of an already completed profile", async () => {
    const runtime = await consentedRuntime();
    await runtime.service.completeOnboarding({ employeeId: "emp_conversational", role: "аналитик", typicalTasks: ["отчёты"], persona: "support", aiLevel: "beginner" });

    await expect(runtime.service.completeOnboarding({ employeeId: "emp_conversational", role: "руководитель", typicalTasks: ["планирование"], persona: "efficiency", aiLevel: "advanced" })).resolves.toMatchObject({
      firstResponse: "Профиль обновлён.",
      profile: { role: "руководитель", typicalTasks: ["планирование"], persona: "efficiency", aiLevel: "advanced" },
    });
    expect(runtime.world.auditEvents.filter((event) => event.type === "profile_updated")).toHaveLength(2);
    expect(runtime.world.auditEvents.filter((event) => event.type === "onboarding_completed")).toHaveLength(1);
  });

  it("does not retain a completed draft when audit or the welcome response fails", async () => {
    const world = createInMemoryWorld();
    const runtime = createInMemoryRuntime({
      world,
      agentRunner: async () => { throw new Error("agent unavailable"); },
      deps: {
        auditEventStore: {
          append: async (event) => {
            if (event.type === "profile_updated" || event.type === "onboarding_completed") throw new Error("audit unavailable");
            world.auditEvents.push(event);
          },
          listCurrent: async () => [],
          listRecent: async () => [],
        },
      },
    });
    await runtime.service.issueInvite({ employeeId: "emp_recovery", inviteCode: "invite_recovery" });
    await runtime.service.openInvite({ inviteCode: "invite_recovery" });
    await runtime.service.acceptConsent({ employeeId: "emp_recovery", accepted: true, source: "test" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_recovery", text: "Аналитик | отчёты | Поддержка | Начинающий" });

    await expect(runtime.service.confirmOnboarding({ employeeId: "emp_recovery" })).resolves.toMatchObject({ firstResponse: "Профиль сохранён. Добро пожаловать!" });
    expect(world.profiles).toHaveLength(1);
    expect(world.onboardingDrafts).toHaveLength(0);
    await expect(runtime.service.confirmOnboarding({ employeeId: "emp_recovery" })).resolves.toMatchObject({ firstResponse: "Профиль уже сохранён." });
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
      deps: {
        onboardingProfileExtractor: async (input) => {
          if (input.text === "Роль — директор") { extractionStarted(); await release; }
          return extractDeterministicOnboardingPatch(input);
        },
      },
    });
    await runtime.service.issueInvite({ employeeId: "emp_completion_race", inviteCode: "invite_completion_race" });
    await runtime.service.openInvite({ inviteCode: "invite_completion_race" });
    await runtime.service.acceptConsent({ employeeId: "emp_completion_race", accepted: true, source: "test" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_completion_race", text: "Аналитик | отчёты | Поддержка | Начинающий" });

    const staleAnswer = runtime.service.submitOnboardingAnswer({ employeeId: "emp_completion_race", text: "Роль — директор" });
    await started;
    await runtime.service.confirmOnboarding({ employeeId: "emp_completion_race" });
    releaseExtraction();
    await expect(staleAnswer).rejects.toMatchObject({ code: "profile_already_completed" });
    expect(world.profiles).toHaveLength(1);
    expect(world.onboardingDrafts).toHaveLength(0);
  });

  it("starts a fresh draft when it expires while extraction is running", async () => {
    let now = "2026-01-01T00:00:00.000Z";
    let expireDuringExtraction = false;
    const world = createInMemoryWorld(() => now);
    const runtime = createInMemoryRuntime({
      world,
      agentRunner: async () => "ok",
      deps: {
        onboardingProfileExtractor: async (input) => {
          if (expireDuringExtraction) now = "2026-02-01T00:00:00.000Z";
          return extractDeterministicOnboardingPatch(input);
        },
      },
    });
    await runtime.service.issueInvite({ employeeId: "emp_expiry_race", inviteCode: "invite_expiry_race" });
    await runtime.service.openInvite({ inviteCode: "invite_expiry_race" });
    await runtime.service.acceptConsent({ employeeId: "emp_expiry_race", accepted: true, source: "test" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_expiry_race", text: "Роль — аналитик" });
    expireDuringExtraction = true;

    await expect(runtime.service.submitOnboardingAnswer({ employeeId: "emp_expiry_race", text: "отчёты" })).resolves.toMatchObject({ status: "needs_answer", field: "role" });
    expect(world.onboardingDrafts[0]).toMatchObject({ createdAt: "2026-02-01T00:00:00.000Z", typicalTasks: ["отчёты"] });
    expect(world.onboardingDrafts[0].role).toBeUndefined();
  });
});
