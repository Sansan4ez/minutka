import { describe, expect, it, vi } from "vitest";
import { runMinutkaCli } from "../../../src/client/cli/minutka-cli.js";
import { InMemoryWorkRetrospectivePolicyStore } from "../../../src/application/work-retrospective-policy.js";
import { ActivityCorrectionService } from "../../../src/application/activity-correction.js";
import { PersistenceOutcomeUnknownError } from "../../../src/application/persistence-error.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetrospectiveRecommendationService, createRecommendationResearchRead, type RecommendationInput } from "../../../src/application/retrospective-recommendations.js";
import { runCompanyReportCommand } from "../../../src/runtime/company-report-command.js";
import { composeRecommendationReporting } from "../../../src/runtime/retrospective-reporting.js";
import { CompanyReportingService } from "../../../src/application/company-reporting.js";
import { ClientReportPublishingService } from "../../../src/application/client-report-publishing.js";
import { hashClientReport } from "../../../src/application/report-preflight.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryActivityCollectionState } from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { EmployeeMinutkaClient, ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { createInProcessEmployeeTransport, createInProcessServiceTransport } from "../../../src/server/http/in-process-transport.js";
import { createTelegramShell } from "../../../src/telegram/telegram-shell.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { SchedulerService } from "../../../src/application/scheduler-service.js";
import { createTelegramScheduledActionRunner } from "../../../src/runtime/scheduled-action-delivery.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryWorkRetrospectiveStore } from "../../../src/application/in-memory-work-retrospective-store.js";
import { createWorkRetrospectiveService } from "../../../src/application/work-retrospective-service.js";

const start = "2026-08-26T12:00:00.000Z";
const scope = { employeeId: "e", companyId: "c", groupId: "g", subjectKey: "s", threadId: "t" };

describe("default retrospective composition", () => {
  it.each([true, false])("SPEC-RETRO-E2E-01/03 CLI short answer and refusal preserve facts; enabled=%s (not live Telegram)", async enabled => {
    let now = start;
    const world = createInMemoryWorld(() => now);
    world.tenantDirectories.groups = [{ id: "g", companyId: "c", period: { start: "2026-08-20", end: "2026-09-09" } }];
    world.participants.push({ ...scope, roleId: "r", status: "profile_completed", createdAt: start, updatedAt: start });
    world.profiles.push({ employeeId: "e", companyId: "c", groupId: "g", roleId: "r", preferredName: "Test", assistantName: "Test", addressForm: "formal", persona: "support", responseLength: "short", timezone: "Etc/UTC", createdAt: start, updatedAt: start });
    const activities = createInMemoryActivityCollectionState();
    let turn = 0;
    const make = () => createInMemoryRuntime({ world, activityState: activities, agentRunner: async () => "unused",
      workRetrospectivePolicies: new InMemoryWorkRetrospectivePolicyStore([{ companyId: "c", groupId: "g", enabled, methodVersion: "v1", period: { start, end: "2026-09-09T23:59:59.000Z" } }]),
      activityExtractor: async input => ({ status: "completed", decision: input.linkedContext
        ? { kind: "linked", handle: input.linkedContext.boundTarget.activityRefs[0]!.activityId, expectedRevision: input.linkedContext.boundTarget.activityRefs[0]!.revision, mode: "patch", correction: { routineLabel: "Подготовил отчёт по шаблону" }, activities: [] }
        : { kind: "collect", activities: [{ routineLabel: "Подготовил отчёт", durationRef: "duration_1" }] },
        context: { currentTextCharacters: 0, staticRulesCharacters: 0, durationReferencesCharacters: 0, recentCandidatesCharacters: 0, promptCharacters: 0 } }),
      assistantAgentRunner: async (_, context) => {
        if (turn === 0 || (enabled && turn === 1)) await context.processCurrentActivityTurn({ mode: "record" });
        if (enabled) await context.workRetrospective!.update(turn === 2 ? { closeReason: "declined" } : {
          ...(turn === 0 ? { statement: { text: "Подготовил отчёт", stage: "actions", kind: "employee_fact" } } : { closeReason: "answered" }),
          question: { text: "По шаблону?", stage: "actions" },
        });
        else expect(context.workRetrospective).toBeUndefined();
        turn++;
        return { text: enabled && turn < 3 ? "По шаблону?" : "Принято", executionTrace: [] };
      } });
    for (const text of ["Подготовил отчёт за полчаса", "Первое", "Не хочу продолжать"]) {
      const runtime = make();
      const assistant = new PersonalAssistantService(runtime.service, runtime.assistantChat!, createInMemoryArtifactStore({ contentStore: createInMemoryArtifactContentStore({ now: () => now }), clock: { now: () => now }, limits: { maximumBytes: 1000000, timeoutMs: 1000 } }));
      const client = new EmployeeMinutkaClient(createInProcessEmployeeTransport(assistant, { kind: "employee", employeeId: "e" }));
      const result = await runMinutkaCli(client, ["employee", "chat", "--thread", "t", "--text", text]);
      expect(result.stderr).toEqual([]);
      expect(result.exitCode).toBe(0);
      now = new Date(Date.parse(now) + 1000).toISOString();
    }
    expect(activities.activities).toHaveLength(1);
    expect(activities.activities[0]).toMatchObject({ durationBucket: "15_30m", revision: enabled ? 2 : 1 });
    const canonical = createInMemoryConversationStore(world);
    const read = await createInMemoryWorkRetrospectiveStore(canonical).readEpisodes({ scope, limit: 10 });
    if (enabled) {
      expect(read).toMatchObject({ value: [{ statements: { actions: [{ text: "Подготовил отчёт" }] } }] });
      if ("value" in read) expect(read.value[0]!.pendingQuestion).toBeUndefined();
    } else {
      expect(world.messages.flatMap(m => m.metadata?.retrospectiveEvents ?? [])).toEqual([]);
    }
  });

  it("SPEC-RETRO-E2E-04 failed Telegram transport cannot count as delivered after restart", async () => {
    const world = createInMemoryWorld(() => start);
    world.tenantDirectories.groups = [{ id: "g", companyId: "c", period: { start: "2026-08-20", end: "2026-09-09" } }];
    world.participants.push({ ...scope, roleId: "r", status: "profile_completed", createdAt: start, updatedAt: start });
    world.profiles.push({ employeeId: "e", companyId: "c", groupId: "g", roleId: "r", preferredName: "Test", assistantName: "Test", addressForm: "formal", persona: "support", responseLength: "short", timezone: "Etc/UTC", createdAt: start, updatedAt: start });
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "unused", assistantAgentRunner: async (_, context) => {
      await context.workRetrospective!.update({ question: { text: "Как проверили?", stage: "value" } });
      return { text: "Как проверили?", executionTrace: [] };
    } });
    const assistant = new PersonalAssistantService(runtime.service, runtime.assistantChat!, createInMemoryArtifactStore({ contentStore: createInMemoryArtifactContentStore({ now: () => start }), clock: { now: () => start }, limits: { maximumBytes: 1000000, timeoutMs: 1000 } }));
    const shell = createTelegramShell({ client: new ServiceMinutkaClient(createInProcessServiceTransport(assistant, { kind: "service", serviceId: "spec" })),
      sessionStore: runtime.telegramSessionStore, pendingActionGroupStore: runtime.pendingActionGroupStore, privacyExplanation: "Test",
      recordResponseDelivery: receipt => runtime.responseDelivery.record(receipt),
      replyPort: { async sendMessage() { throw new Error("test transport unavailable"); }, async editReplyMarkup() {}, async sendChatAction() {}, async answerCallbackQuery() {} } });
    await runtime.telegramSessionStore.claim({ identity: { chatId: "chat" }, session: { employeeId: "e", threadId: "t", createdAt: start, updatedAt: start } });
    await runtime.telegramSessionStore.markConsentAccepted({ identity: { chatId: "chat" }, employeeId: "e", acceptedAt: start });
    await expect(shell.handleText("chat", "Сделал отчёт")).rejects.toThrow("test transport unavailable");
    const canonical = createInMemoryConversationStore(world);
    expect(await createInMemoryWorkRetrospectiveStore(canonical).readEpisodes({ scope, limit: 10 })).toMatchObject({ value: [{ questionBudget: { dailyDelivered: 0 } }] });
    expect(world.messages.flatMap(m => m.metadata?.retrospectiveEvents ?? []).some(e => e.action.type === "response_delivery" && e.action.status === "delivered")).toBe(false);
  });
  it.each(["success", "stale", "foreign", "unknown"] as const)("SPEC-RETRO-E2E-02 continuity after restart, stale/foreign/unknown correction: %s", async mode => {
    let now = start;
    const world = createInMemoryWorld(() => now);
    world.tenantDirectories.groups = [{ id: "g", companyId: "c", period: { start: "2026-08-20", end: "2026-09-09" } }];
    world.participants.push({ ...scope, roleId: "r", status: "profile_completed", createdAt: start, updatedAt: start });
    world.profiles.push({ employeeId: "e", companyId: "c", groupId: "g", roleId: "r", preferredName: "Test", assistantName: "Test", addressForm: "formal", persona: "support", responseLength: "short", timezone: "Etc/UTC", createdAt: start, updatedAt: start });
    const activities = createInMemoryActivityCollectionState();
    const outcomes: unknown[] = [];
    const make = () => createInMemoryRuntime({ world, activityState: activities, agentRunner: async () => "unused",
      activityExtractor: async input => ({ status: "completed", decision: input.linkedContext
        ? { kind: "linked", handle: input.linkedContext.boundTarget.activityRefs[0]!.activityId,
          expectedRevision: input.linkedContext.boundTarget.activityRefs[0]!.revision, mode: "patch", correction: { routineLabel: input.currentText }, activities: [] }
        : { kind: "collect", activities: [{ routineLabel: "Подготовил отчёт", durationRef: "duration_1" }] },
        context: { currentTextCharacters: 0, staticRulesCharacters: 0, durationReferencesCharacters: 0, recentCandidatesCharacters: 0, promptCharacters: 0 } }),
      assistantAgentRunner: async (_, context) => {
        outcomes.push(await context.processCurrentActivityTurn({ mode: "record" }));
        await context.workRetrospective!.update({ closeReason: "answered", question: { text: "Как проверили?", stage: "value" } });
        return { text: "Как проверили?", executionTrace: [] };
      } });
    const chat = (runtime: ReturnType<typeof make>, text: string) => runtime.assistantChat!.chat({ userId: "e", threadId: "t", text });
    const read = () => {
      const conversations = createInMemoryConversationStore(world);
      return createWorkRetrospectiveService(createInMemoryWorkRetrospectiveStore(conversations), conversations).readEpisodes({ scope, limit: 10 });
    };
    const runtime = make();
    await chat(runtime, "Подготовил отчёт за полчаса");
    expect(outcomes[0]).toMatchObject({ status: "completed", operation: "collect" });
    const activityId = activities.activities[0]!.activityId;
    if (mode === "stale") activities.activities[0]!.revision = 2;
    if (mode === "foreign") activities.activities[0]!.groupId = "foreign";
    const spy = mode === "unknown" ? vi.spyOn(ActivityCorrectionService.prototype, "correct").mockRejectedValue(new PersistenceOutcomeUnknownError()) : undefined;
    try {
      now = new Date(Date.parse(now) + 1000).toISOString();
      await chat(runtime, "Проверил по шаблону");
      expect(outcomes[1]).toMatchObject({ status: "linked", outcomes: [{ status: mode === "success" ? "completed" : mode === "unknown" ? "outcome_unknown" : "failed" }] });
      expect(await read()).toMatchObject({ value: [{ activityRefs: [{ activityId, revision: mode === "success" ? 2 : 1 }], messageRefs: mode === "success" ? expect.arrayContaining([{ messageId: world.messages.at(-1)!.id }]) : expect.any(Array) }] });
      if (mode === "success") {
        now = new Date(Date.parse(now) + 1000).toISOString();
        await chat(make(), "Сверил итоговые поля");
        expect(outcomes[2]).toMatchObject({ status: "linked", outcomes: [{ status: "completed", revision: 3 }] });
        expect(await read()).toMatchObject({ value: [{ activityRefs: [{ activityId, revision: 3 }] }] });
      }
      expect(activities.activities).toHaveLength(1);
      expect(activities.activities[0]).toMatchObject({ revision: mode === "success" ? 3 : mode === "stale" ? 2 : 1, durationBucket: "15_30m",
        routineLabel: mode === "success" ? "Сверил итоговые поля" : "Подготовил отчёт" });
    } finally { spy?.mockRestore(); }
  });
  it("SPEC-RETRO-E2E-01 full cycle: facts, four stages, step, week2, final and operator publish", async () => {
    let now = start;
    const world = createInMemoryWorld(() => now);
    world.tenantDirectories.groups = [{ id: "g", companyId: "c", period: { start: "2026-08-20", end: "2026-09-09" } }];
    world.participants.push({ ...scope, roleId: "r", status: "profile_completed", createdAt: start, updatedAt: start });
    world.profiles.push({ employeeId: "e", companyId: "c", groupId: "g", roleId: "r", preferredName: "Test", assistantName: "Test", addressForm: "formal", persona: "support", responseLength: "short", timezone: "Etc/UTC", createdAt: start, updatedAt: start });
    const activities = createInMemoryActivityCollectionState();
    const sends: string[] = [];
    let first = true;
    let weekly = false;
    let reportFacts = false;
    let weeklyCount = 0;
    let stage = 0;
    let followUp = false;
    let summary: Awaited<ReturnType<Parameters<import("../../../src/application/assistant-service.js").AssistantAgentRunner>[1]["readCycleActivities"]>> | undefined;
    const make = (previous?: ReturnType<typeof createInMemoryRuntime>) => {
      const runtime = createInMemoryRuntime({ world, activityState: activities,
        telegramSessionStore: previous?.telegramSessionStore, scheduleStore: previous?.scheduleStore,
        agentRunner: async () => "unused",
        activityExtractor: async input => ({ status: "completed", decision: input.linkedContext
          ? { kind: "linked", handle: input.linkedContext.boundTarget.activityRefs[0]!.activityId, expectedRevision: 1, mode: "patch", correction: { routineLabel: "Подготовил отчёт по шаблону" }, activities: [] }
          : { kind: "collect", activities: [{ routineLabel: "Подготовил отчёт", routineId: "report", durationRef: "duration_1" }] },
          context: { currentTextCharacters: 0, staticRulesCharacters: 0, durationReferencesCharacters: 0, recentCandidatesCharacters: 0, promptCharacters: 0 } }),
        assistantAgentRunner: async (_, context) => {
          expect(context.workRetrospective).toBeDefined();
          if (reportFacts) {
            await context.processCurrentActivityTurn({ mode: "record" });
            await context.workRetrospective!.update({ statement: { text: "Подготовил отчёт", stage: "actions", kind: "employee_fact" } });
            return { text: "Принято", executionTrace: [] };
          }
          if (context.workRetrospective!.scheduled) {
            summary = await context.readCycleActivities();
            return { text: "Продолжим?", executionTrace: [] };
          }
          if (followUp) {
            summary = await context.readCycleActivities();
            await context.workRetrospective!.update({ statement: { text: "Попробовал проверку: пропусков не было", stage: "value", kind: "employee_fact" } });
            return { text: "Результат сохранён", executionTrace: [] };
          }
          if (stage > 0) {
            const stages = ["value", "future", "indicators"] as const;
            const current = stages[stage - 1]!;
            await context.workRetrospective!.update({ closeReason: "answered", statement: { text: "Ответ сотрудника", stage: current, kind: current === "future" ? "intention" : "employee_interpretation" },
              ...(current === "future" ? { selectedStep: "Проверять отчёт", followUpConsent: true } : {}),
              ...(current === "indicators" ? { indicator: { sign: "Пропущенное поле", meaning: "Неполный отчёт", reaction: "Поправить список" } } : { question: { text: "Следующий этап?", stage: stages[stage]! } }) });
            stage++;
            return { text: current === "indicators" ? "Итог сохранён" : "Следующий этап?", executionTrace: [] };
          }
          if (weekly) {
            await context.workRetrospective!.update({ ...(weeklyCount === 0 ? { weeklyConsent: true } : { closeReason: "answered" }), question: { text: "Что изменилось?", stage: "value" } });
            weeklyCount++;
            return { text: "Что изменилось?", executionTrace: [] };
          }
          expect(await context.processCurrentActivityTurn({ mode: "record" })).toMatchObject({ status: first ? "completed" : "linked" });
          if (first) {
            first = false;
            await context.workRetrospective!.update({ statement: { text: "Подготовил отчёт", stage: "actions", kind: "employee_fact" }, question: { text: "По шаблону или с нуля?", stage: "actions" } });
            return { text: "По шаблону или с нуля?", executionTrace: [] };
          }
          const bound = JSON.parse(await context.workRetrospective!.read());
          expect(bound.active.question.text).toBe("По шаблону или с нуля?");
          await context.workRetrospective!.update({ closeReason: "answered", question: { text: "Как поняли, что результат подходит?", stage: "value" } });
          stage = 1;
          return { text: "Как поняли, что результат подходит?", executionTrace: [] };
        } });
      const assistant = new PersonalAssistantService(runtime.service, runtime.assistantChat!, createInMemoryArtifactStore({ clock: { now: () => now }, contentStore: createInMemoryArtifactContentStore({ now: () => now }), limits: { maximumBytes: 1000000, timeoutMs: 1000 } }));
      const transport = createInProcessServiceTransport(assistant, { kind: "service", serviceId: "spec" });
      const client = new ServiceMinutkaClient(transport);
      const shell = createTelegramShell({ client,
        sessionStore: runtime.telegramSessionStore, pendingActionGroupStore: runtime.pendingActionGroupStore,
        privacyExplanation: "Test", now: () => now, recordResponseDelivery: receipt => runtime.responseDelivery.record(receipt),
        replyPort: { async sendMessage(_chat, text) { sends.push(text); return { messageId: sends.length }; }, async editReplyMarkup() {}, async sendChatAction() {}, async answerCallbackQuery() {} } });
      const scheduler = new SchedulerService(runtime.scheduleStore, { now: () => now }, createTelegramScheduledActionRunner({ assistant, telegramSessionStore: runtime.telegramSessionStore, telegramShell: shell }), undefined, runtime.touchPolicy);
      return { runtime, shell, scheduler, client };
    };
    const f = make();
    await f.runtime.telegramSessionStore.claim({ identity: { chatId: "chat" }, session: { employeeId: "e", threadId: "t", createdAt: start, updatedAt: start } });
    await f.runtime.telegramSessionStore.markConsentAccepted({ identity: { chatId: "chat" }, employeeId: "e", acceptedAt: start });
    await f.client.forEmployee("e").getProfile();
    await f.shell.handleText("chat", "Подготовил отчёт за полчаса");
    expect(sends).toEqual(["По шаблону или с нуля?"]);
    expect(activities.activities).toHaveLength(1);
    const restarted = make(f.runtime);
    const episodes = createWorkRetrospectiveService(createInMemoryWorkRetrospectiveStore(createInMemoryConversationStore(world)), createInMemoryConversationStore(world));
    expect(await episodes.readEpisodes({ scope, limit: 10 })).toMatchObject({ status: "applied", value: [{ pendingQuestion: { text: "По шаблону или с нуля?" }, questionBudget: { dailyDelivered: 1 } }] });
    await restarted.scheduler.saveDailySchedule("e", { id: "evening", processId: "evening_reflection", timeOfDay: "19:00", timezone: "Etc/UTC", enabled: true });
    now = "2026-08-26T19:00:00.000Z";
    await restarted.scheduler.tick();
    expect(sends).toHaveLength(2);
    expect(world.messages.at(-1)?.metadata?.scheduledProvenance?.retrospectiveTouch?.preservePendingQuestion).toBe(true);
    await restarted.shell.handleText("chat", "Первое");
    expect(sends.at(-1)).toBe("Как поняли, что результат подходит?");
    expect(activities.activities).toHaveLength(1);
    expect(activities.activities[0]).toMatchObject({ revision: 2, routineLabel: "Подготовил отчёт по шаблону", durationBucket: "15_30m" });
    expect(await episodes.readEpisodes({ scope: { ...scope, groupId: "foreign" }, limit: 10 })).not.toMatchObject({ value: [{ pendingQuestion: expect.anything() }] });
    for (const text of ["Коллега принял отчёт", "Буду проверять по списку", "Если поле пропущено, дополню список"]) {
      now = new Date(Date.parse(now) + 1000).toISOString();
      await restarted.shell.handleText("chat", text);
    }
    expect(activities.activities).toHaveLength(1);
    expect(await episodes.readEpisodes({ scope, limit: 10 })).toMatchObject({ value: [{ statements: {
      actions: [{ kind: "employee_fact" }], value: [{ kind: "employee_interpretation" }], future: [{ kind: "intention" }], indicators: [{ kind: "employee_interpretation" }],
    }, selectedStep: { text: "Проверять отчёт" }, indicator: { sign: "Пропущенное поле" }, followUpConsent: { granted: true } }] });
    // Week-two consent comes from a real reply, not the scheduled invitation.
    now = "2026-08-31T12:00:00.000Z";
    weekly = true;
    stage = 0;
    for (let index = 0; index < 8; index++) {
      await restarted.shell.handleText("chat", index === 0 ? "Да, продолжим недельный разбор" : "Продолжим");
      now = new Date(Date.parse(now) + 1000).toISOString();
    }
    const before = world.messages.flatMap(turn => turn.metadata?.retrospectiveEvents ?? []).filter(event => event.action.type === "question_generated").length;
    await restarted.shell.handleText("chat", "Ещё вопрос");
    expect(world.messages.flatMap(turn => turn.metadata?.retrospectiveEvents ?? []).filter(event => event.action.type === "question_generated")).toHaveLength(before);
    expect(await episodes.readEpisodes({ scope, limit: 10 })).toMatchObject({ value: [{ questionBudget: { weeklySession: { delivered: 8 } } }] });
    await restarted.scheduler.saveDailySchedule("e", { id: "weekly", processId: "weekly_summary", timeOfDay: "17:00", timezone: "Etc/UTC", enabled: true });
    now = "2026-08-31T17:00:00.000Z";
    await restarted.scheduler.tick();
    expect(summary).toMatchObject({ activityCount: 1, retrospective: { episodes: [{ intentions: expect.arrayContaining([expect.objectContaining({ text: "Проверять отчёт" })]), followUp: { step: { text: "Проверять отчёт" } } }] } });
    const delivered = sends.length;
    now = "2026-08-31T19:00:00.000Z";
    await make(restarted.runtime).scheduler.tick();
    expect(sends).toHaveLength(delivered);
    weekly = false;
    followUp = true;
    now = "2026-09-02T12:00:00.000Z";
    await make(restarted.runtime).shell.handleText("chat", "Попробовал проверку: пропусков не было");
    expect(summary).toMatchObject({ retrospective: { episodes: [{ followUp: { step: { text: "Проверять отчёт" }, indicator: { sign: "Пропущенное поле" } } }] } });
    expect(activities.activities).toHaveLength(1);
    await restarted.scheduler.saveDailySchedule("e", { id: "final", processId: "final_report", timeOfDay: "17:00", timezone: "Etc/UTC", enabled: true });
    now = "2026-09-09T17:00:00.000Z";
    await restarted.scheduler.tick();
    expect(summary).toMatchObject({ retrospective: { episodes: [{ confirmed: expect.arrayContaining([expect.objectContaining({ text: "Попробовал проверку: пропусков не было" })]) }] } });
    followUp = false;
    // Collect aggregate evidence via commands, never seed a checked artifact.
    reportFacts = true;
    now = "2026-09-01T12:00:00.000Z";
    world.participants.push({ ...world.participants[0]!, employeeId: "e2", subjectKey: "s2" });
    world.profiles.push({ ...world.profiles[0]!, employeeId: "e2" });
    for (const userId of ["e", "e2"]) for (let index = 0; index < 3; index++) {
      now = `2026-09-0${index + 1}T12:00:00.000Z`;
      await restarted.runtime.assistantChat!.chat({ userId, threadId: "research", text: "Подготовил отчёт за полчаса" });
    }
    const reportScope = { companyId: "c", groupId: "g" };
    const research = createRecommendationResearchRead({
      participants: async () => world.participants.map(p => ({ employeeId: p.employeeId, companyId: p.companyId, groupId: p.groupId, subjectKey: p.subjectKey, threadId: "research" })),
      episodes, evidence: { async listRoutineEvidence() { return {
        messages: world.messages.map(m => ({ messageId: m.id, subjectKey: world.participants.find(p => p.employeeId === m.employeeId)!.subjectKey, userText: m.text, agentResponse: m.response, timestamp: m.timestamp })),
        activities: activities.activities.map(({ employeeId: _owner, ...a }) => a),
      }; } },
    });
    let generations = 0;
    const clock = { now: () => now };
    const contents = createInMemoryArtifactContentStore(clock);
    const bodies = new Map<string, string>();
    const put = contents.put.bind(contents);
    contents.put = async input => {
      const chunks: Buffer[] = [];
      for await (const chunk of input.openStream()) chunks.push(Buffer.from(chunk));
      bodies.set(input.contentDigest, Buffer.concat(chunks).toString());
      return put(input);
    };
    const artifacts = createInMemoryArtifactStore({ clock, contentStore: contents, limits: { maximumBytes: 1000000, timeoutMs: 1000 } });
    const generator = { version: "model-boundary/v1", async generate(input: RecommendationInput) {
      generations++;
      const refs = input.episodes.map(e => ({ ...reportScope, subjectKey: e.subjectKey, threadId: e.threadId, episodeId: e.episodeId, revision: e.revision, statementId: e.statements.actions[0]!.statementId, quote: "Подготовил отчёт" }));
      const claim = { text: "Подготовил отчёт", refs };
      return [{ operation: claim, opportunity: claim, known: { input: null, output: null, method: claim, criterion: claim }, facts: [claim], hypotheses: [], technicalQuestions: [], unknowns: ["Доступность API"], change: "Подготовить черновик", humanControl: "Проверить до записи", firstTest: "Один пример без записи", expectedSign: "Поля совпали", stopCondition: "Остановить при расхождении", disposition: "recommendation" as const }];
    } };
    const recommendationDeps = { research, generator, artifacts, contents, clock, async loadContent(url: string) { return bodies.get(new URL(url).pathname.split("/").at(-1)!)!; } };
    let recommendations = new RetrospectiveRecommendationService(recommendationDeps);
    const command = async (argv: string[]) => {
      let output = "";
      await runCompanyReportCommand([...argv, "--company", "c", "--group", "g"], { recommendations, reporting: { async buildReport() { throw new Error("unused"); } }, checkLlm: async () => { throw new Error("unused"); } }, text => { output += text; });
      return JSON.parse(output);
    };
    const draft = await command(["prepare-recommendations"]);
    expect(draft.status).toBe("applied");
    const read = await recommendations.read(reportScope, draft.artifactId);
    if (read.status !== "applied") throw new Error("draft missing");
    expect(read.value.candidates[0]!.status).toBe("draft");
    const temp = await mkdtemp(join(tmpdir(), "retro-e2e-"));
    try {
      const file = join(temp, "decisions.json");
      await writeFile(file, JSON.stringify({ operatorId: "operator", decisions: { [read.value.candidates[0]!.candidateId]: "checked" } }));
      expect(await command(["check-recommendations", "--artifact", draft.artifactId, "--decisions", file])).toMatchObject({ status: "applied", version: 2 });
    } finally { await rm(temp, { recursive: true, force: true }); }
    recommendations = new RetrospectiveRecommendationService(recommendationDeps);
    expect(await recommendations.readLatest(reportScope)).toMatchObject({ status: "applied", value: { version: 2, candidates: [{ status: "checked" }] } });
    now = "2026-09-10T12:00:00.000Z";
    const reportingService = new CompanyReportingService({ async loadGroupSnapshot() { return { invitedParticipants: 2, subjects: world.participants.map(p => ({ subjectKey: p.subjectKey, roleId: p.roleId })), activities: activities.activities,
      reference: { companyLabel: "Company", groupLabel: "Group", roleLabels: { r: "Role" }, period: { start: "2026-08-20", end: "2026-09-09" } } }; } }, () => now,
      composeRecommendationReporting({ research, service: recommendations, directory: { async getGroupPeriod() { return { start: "2026-08-20", end: "2026-09-09" }; } } }));
    const reporting = { buildReport: (input: typeof reportScope) => reportingService.buildReport({ ...input, directory: { schemaVersion: "minutka-routine-directory/v1", companyId: "c", version: "1", sections: [{ roleId: "r", entries: [{ id: "report", name: "Сборка результата", description: "Отчёт", examples: [], quickWin: "deep_dive", provenance: [{ groupId: "g", subjectKey: "s" }, { groupId: "g", subjectKey: "s2" }] }] }] } }) };
    const beforeGeneration = generations;
    const report = await reporting.buildReport(reportScope);
    expect(report.client.recommendations).toHaveLength(1);
    expect((await reporting.buildReport(reportScope)).client).toEqual(report.client);
    expect(JSON.stringify(report.client)).not.toMatch(/subjectKey|episodeRefs|statementId|operatorId|Подготовил отчёт/);
    const publishing = new ClientReportPublishingService(reporting, createInMemoryAuditEventStore(world), clock, createDeterministicIdGenerator());
    expect(await publishing.publishClientReport({ ...reportScope, findings: { schemaVersion: "minutka-report-preflight-findings/v1", scope: "c/g", reportVersion: hashClientReport(report.client), findings: [] }, operatorDecision: "publish" })).toMatchObject({ ok: true });
    expect(generations).toBe(beforeGeneration);
    const { ActivityCorrectionService } = await import("../../../src/application/activity-correction.js");
    const { createInMemoryActivityMutationStore } = await import("../../../src/application/in-memory-activity-collection-store.js");
    const currentEvidence = await research.read(reportScope);
    const cited = currentEvidence.episodes.find(e => e.subjectKey === "s2")!.activityRefs.at(-1)!;
    const target = activities.activities.find(a => a.activityId === cited.activityId)!;
    await new ActivityCorrectionService(createInMemoryActivityMutationStore(activities), { now: () => "2026-09-03T13:00:00.000Z" }).correct({ employeeId: "e2", companyId: "c", groupId: "g", sourceMessageId: "correction" }, { handle: target.activityId, expectedRevision: 1, mode: "patch", correction: { routineLabel: "Исправленный отчёт" } });
    // Message-only provenance and an unchanged episode: activity-only correction must invalidate approval.
    expect((await research.read(reportScope)).episodes).toEqual(currentEvidence.episodes);
    now = "2026-09-10T12:00:00.000Z";
    expect((await reporting.buildReport(reportScope)).client.recommendations).toEqual([]);
    expect(await publishing.publishClientReport({ ...reportScope, findings: { schemaVersion: "minutka-report-preflight-findings/v1", scope: "c/g", reportVersion: hashClientReport(report.client), findings: [] }, operatorDecision: "publish" })).toMatchObject({ ok: false, reason: "stale_findings" });
    expect(generations).toBe(beforeGeneration);
  });
});
