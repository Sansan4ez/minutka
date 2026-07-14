import { describe, expect, it } from "vitest";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";

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

  it("does not overwrite a draft with conflicting extracted data", async () => {
    const runtime = await consentedRuntime();
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Роль — аналитик" });
    await runtime.service.submitOnboardingAnswer({ employeeId: "emp_conversational", text: "Роль — менеджер" });
    expect(runtime.world.onboardingDrafts[0].role).toBe("аналитик");
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
});
