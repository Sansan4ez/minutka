import { describe, expect, it } from "vitest";
import { AssistantService, type AssistantAgentRunner } from "../../../src/application/assistant-service.js";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import { CompanyReportingService } from "../../../src/application/company-reporting.js";
import { CycleActivitySummaryService } from "../../../src/application/cycle-activity-summary.js";
import { FinalReportArmingService } from "../../../src/application/final-report-arming.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { ResearchScopePurgeService } from "../../../src/application/research-scope-purge.js";
import { ScheduleManagementService } from "../../../src/application/schedule-management-service.js";
import { SchedulerService } from "../../../src/application/scheduler-service.js";
import { WeeklyActivitySummaryService } from "../../../src/application/weekly-activity-summary.js";
import { createInMemoryActivityCollectionState, createInMemoryActivityCollectionStore, createInMemoryOwnActivityReadStore } from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryCompanyReportStore } from "../../../src/application/in-memory-company-report-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryFeedbackStore } from "../../../src/application/in-memory-feedback-store.js";
import { createInMemoryInsightStore } from "../../../src/application/in-memory-insight-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryResearchScopePurgeStore } from "../../../src/application/in-memory-research-scope-purge-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createRuntimeProjectionBuilder } from "../../../src/application/runtime-projections/runtime-projection-builder.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import type { CollectActivityInput } from "../../../src/contracts/minutka-activity.js";
import { createInMemoryRuntime, executableSpecPrivacyExplanation } from "../../../src/runtime/create-in-memory-runtime.js";
import { createTelegramScheduledActionRunner } from "../../../src/runtime/scheduled-action-delivery.js";
import { runResearchScopePurgeCommand } from "../../../src/runtime/research-scope-purge-command.js";
import { runScheduledProcessOnDemand } from "../../../src/runtime/run-scheduled-process.js";
import { TelegramDriver } from "../support/telegram-driver.js";

/**
 * The employee-local timezone of the whole gate. Every activity is recorded at
 * 19:00 local time, so the Moscow calendar day and the UTC one agree and the
 * windows below can be read directly.
 */
const timezone = "Europe/Moscow";
/** Last day of the two-week cycle: the weekly window is 08-22..08-28, the cycle window 08-15..08-28. */
const lastCycleDay = "2026-08-28T14:00:00.000Z";

type Participant = { employeeId: string; companyId: string; groupId: string; roleId: string };

const employeeA: Participant = { employeeId: "employee_a", companyId: "default_company", groupId: "default_group", roleId: "default_role" };
const employeeB: Participant = { employeeId: "employee_b", companyId: "default_company", groupId: "default_group", roleId: "default_role" };
const employeeC: Participant = { employeeId: "employee_c", companyId: "company_b", groupId: "group_b", roleId: "role_b" };

/** One scripted evening fact per day of the cycle, keyed by the text the employee sends. */
const scriptedFacts = new Map<string, { at: string; activity: CollectActivityInput }>([
  ["ФАКТ: отчёт вручную 17", { at: "2026-08-17T16:00:00.000Z", activity: { taskCategory: "reporting", routinePattern: "manual_reporting", durationBucket: "1_2h", system: "spreadsheets" } }],
  ["ФАКТ: отчёт вручную 19", { at: "2026-08-19T16:00:00.000Z", activity: { taskCategory: "reporting", routinePattern: "manual_reporting", system: "spreadsheets" } }],
  ["ФАКТ: встреча 21", { at: "2026-08-21T16:00:00.000Z", activity: { taskCategory: "meetings", energyStressMarker: "fatigue" } }],
  ["ФАКТ: отчёт можно автоматизировать 24", { at: "2026-08-24T16:00:00.000Z", activity: { taskCategory: "reporting", automationCandidate: "report_generation", system: "spreadsheets" } }],
  ["ФАКТ: отчёт вручную 26", { at: "2026-08-26T16:00:00.000Z", activity: { taskCategory: "reporting", routinePattern: "manual_reporting" } }],
  ["ФАКТ: отчёт 27", { at: "2026-08-27T16:00:00.000Z", activity: { taskCategory: "reporting" } }],
  ["ФАКТ: согласование 25", { at: "2026-08-25T16:00:00.000Z", activity: { taskCategory: "coordination" } }],
]);

type Harness = Awaited<ReturnType<typeof createHarness>>;

function createHarness() {
  let currentTime = lastCycleDay;
  const clock = { now: () => currentTime };
  const world = createInMemoryWorld(clock.now);
  world.tenantDirectories.groups.push({ id: employeeC.groupId, companyId: employeeC.companyId });
  world.tenantDirectories.roles.push({ id: employeeC.roleId, companyId: employeeC.companyId, name: "Оператор" });

  const identityRuntime = createInMemoryRuntime({ world, agentRunner: async () => "unused" });
  const profileStore = createInMemoryProfileStore(world);
  const documents = createInMemoryDocumentStore(clock);
  const conversationStore = createInMemoryConversationStore(world);
  const activityState = createInMemoryActivityCollectionState();
  let activityIndex = 0;
  const activities = new CollectActivityService(
    createInMemoryActivityCollectionStore(activityState),
    clock,
    () => `activity_${++activityIndex}`,
  );
  const ownActivities = createInMemoryOwnActivityReadStore(activityState);
  const weekly = new WeeklyActivitySummaryService(ownActivities, clock);
  const cycle = new CycleActivitySummaryService(ownActivities, clock);

  /** What the agent actually saw, so the gate asserts the read and not the wording. */
  const observed = {
    scheduledPrompts: [] as string[],
    weekly: [] as Array<Awaited<ReturnType<WeeklyActivitySummaryService["summarize"]>>>,
    cycle: [] as Array<Awaited<ReturnType<CycleActivitySummaryService["summarize"]>>>,
  };

  const runner: AssistantAgentRunner = async (input, context) => {
    const text = input.text;
    const fact = scriptedFacts.get(text);
    if (fact) {
      context.markProcessUsed("evening_reflection");
      await context.collectActivities({ activities: [fact.activity] });
      return { text: "Записал факт дня.", executionTrace: [] };
    }
    if (text.includes("morning_planning")) {
      observed.scheduledPrompts.push(text);
      context.markProcessUsed("morning_planning");
      return { text: "1. Сверить цифры\nПервый шаг: открыть таблицу.", executionTrace: [] };
    }
    if (text.includes("evening_reflection")) {
      observed.scheduledPrompts.push(text);
      context.markProcessUsed("evening_reflection");
      return { text: "Что ещё добавить к уже отмеченным фактическим активностям?", executionTrace: [] };
    }
    if (text.includes("weekly_summary") || text.startsWith("Да,") || text.startsWith("Нет,")) {
      context.markProcessUsed("weekly_summary");
      const summary = await context.readWeeklyActivities();
      observed.weekly.push(summary);
      if (text.startsWith("Да,")) {
        await context.updatePersonalContext({ typicalTasks: ["еженедельный отчёт по продажам"] });
        return { text: "Записал в контекст: еженедельный отчёт по продажам.", executionTrace: [] };
      }
      if (text.startsWith("Нет,")) return { text: "Хорошо, не записываю это как паттерн.", executionTrace: [] };
      if (!summary.sufficientData) return { text: "За неделю данных мало, не достраиваю картину.", executionTrace: [] };
      return { text: `За неделю активностей: ${summary.activityCount}. Похоже на правду?`, executionTrace: [] };
    }
    if (text.includes("final_report")) {
      context.markProcessUsed("final_report");
      const summary = await context.readCycleActivities();
      observed.cycle.push(summary);
      if (!summary.sufficientData) return { text: "За цикл данных мало, ограничиваюсь тем, что есть.", executionTrace: [] };
      return {
        text: [
          `Итог цикла: повторялось — ${summary.confirmedPatterns.taskCategories.join(", ")}.`,
          `Рутина — ${summary.confirmedPatterns.routinePatterns.join(", ")}.`,
          "Шаги: соберите отчёт по шаблону; вынесите сверку в один файл.",
        ].join("\n"),
        executionTrace: [],
      };
    }
    return { text: `Ответ: ${text}`, executionTrace: [] };
  };

  const assistantChat = new AssistantService(runner, {
    documentStore: documents,
    conversationStore,
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock) }),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    participantStore: profileStore,
    chatProjectionBuilder: createRuntimeProjectionBuilder({
      profileStore,
      conversationStore,
      insightStore: createInMemoryInsightStore(world),
      feedbackStore: createInMemoryFeedbackStore(world),
      auditEventStore: createInMemoryAuditEventStore(world),
      clock,
    }),
    collectActivities: (command) => activities.collectBatch(command),
    readWeeklyActivities: (command) => weekly.summarize(command),
    readCycleActivities: (command) => cycle.summarize(command),
    auditEventStore: createInMemoryAuditEventStore(world),
    clock,
    idGenerator: createDeterministicIdGenerator(),
  });

  const scheduleManagement = new ScheduleManagementService(identityRuntime.scheduleStore, profileStore, clock);
  const reporting = new CompanyReportingService(
    createInMemoryCompanyReportStore({ participants: world.participants, activities: activityState }),
    clock.now,
  );
  const application = new PersonalAssistantService(
    identityRuntime.service,
    assistantChat,
    createInMemoryArtifactStore({
      contentStore: createInMemoryArtifactContentStore(clock),
      clock,
      limits: { maximumBytes: 1_000_000, timeoutMs: 1_000 },
    }),
    undefined,
    undefined,
    undefined,
    scheduleManagement,
    undefined,
    undefined,
    reporting,
  );
  const telegram = new TelegramDriver(world, async () => "unused", {}, true, undefined, {
    ...identityRuntime,
    service: application,
  });
  const purge = new ResearchScopePurgeService(
    createInMemoryResearchScopePurgeStore({ world, activities: activityState }),
    { async deleteByEmployee() { return { deletedObjectVersions: 0 }; } },
  );

  return {
    world, identityRuntime, application, telegram, profileStore, activityState, observed,
    weekly, cycle, reporting, purge, scheduleManagement, scheduleStore: identityRuntime.scheduleStore,
    at: (moment: string) => { currentTime = moment; },
    now: () => currentTime,
  };
}

async function onboard(harness: Harness, participant: Participant, profile: {
  preferredName: string; selfDescription?: string; typicalTasks?: string[]; aiLevel?: "beginner" | "intermediate"; programGoal?: string;
}) {
  const chatId = `chat_${participant.employeeId}`;
  const userId = `telegram_${participant.employeeId}`;
  await harness.identityRuntime.service.issueInvite({
    employeeId: participant.employeeId,
    inviteCode: `invite_${participant.employeeId}`,
    companyId: participant.companyId,
    groupId: participant.groupId,
  });
  await harness.telegram.start({ chatId, userId, inviteCode: `invite_${participant.employeeId}` });
  const consentMessage = harness.telegram.sentMessages().at(-1);
  expect(consentMessage?.text).toBe(executableSpecPrivacyExplanation);
  const callbackData = consentMessage?.replyMarkup?.inlineKeyboard[0]?.[0]?.callbackData;
  if (!callbackData || consentMessage?.messageId === undefined) throw new Error("privacy-v6 consent action was not rendered");
  await harness.telegram.clickCallback({ chatId, userId, callbackData, messageId: consentMessage.messageId });
  await harness.application.completeOnboarding({
    employeeId: participant.employeeId,
    roleId: participant.roleId,
    persona: "efficiency",
    responseLength: "short",
    timezone,
    ...profile,
  });
  expect(harness.world.consents).toContainEqual(expect.objectContaining({
    employeeId: participant.employeeId, privacyVersion: "privacy-v6", source: "telegram",
  }));
  harness.telegram.clear();
  return { chatId, userId };
}

/** One evening fact, sent on its own local day through the Telegram text path. */
async function sendFact(harness: Harness, identity: { chatId: string; userId: string }, text: string) {
  const fact = scriptedFacts.get(text);
  if (!fact) throw new Error(`unscripted fact: ${text}`);
  harness.at(fact.at);
  await harness.telegram.sendText({ ...identity, text });
  harness.at(lastCycleDay);
}

describe("SPEC-MINUTKA-PERSONAL-GATE-001: personal context to weekly summary to final report", () => {
  it("carries one employee from onboarding through daily facts, the weekly checkpoint and the final report", async () => {
    const harness = createHarness();
    const identityA = await onboard(harness, employeeA, {
      preferredName: "Анна",
      selfDescription: "Координирую тендеры",
      typicalTasks: ["Подготовка заявок"],
      aiLevel: "intermediate",
      programGoal: "Сократить ручную проверку",
    });
    const identityB = await onboard(harness, employeeB, { preferredName: "Борис" });

    // 1. Onboarding writes the personal profile context, and /context shows it
    //    back without ids, another participant, or an invented observation.
    const initialContext = await harness.application.getPersonalContext({ employeeId: employeeA.employeeId });
    expect(initialContext).toMatchObject({
      confirmedProfile: {
        preferredName: "Анна", persona: "efficiency", responseLength: "short", timezone,
        exactRole: "Участник", selfDescription: "Координирую тендеры", typicalTasks: ["Подготовка заявок"],
        aiLevel: "intermediate", programGoal: "Сократить ручную проверку",
      },
      observations: { status: "none_confirmed", items: [] },
    });
    expect(JSON.stringify(initialContext)).not.toMatch(/employee_a|employee_b|default_company|default_group|default_role|subject|Борис/u);

    // 2. Daily facts of both employees, each on its own local day.
    for (const text of ["ФАКТ: отчёт вручную 17", "ФАКТ: отчёт вручную 19", "ФАКТ: встреча 21", "ФАКТ: отчёт можно автоматизировать 24", "ФАКТ: отчёт вручную 26", "ФАКТ: отчёт 27"]) {
      await sendFact(harness, identityA, text);
    }
    await sendFact(harness, identityB, "ФАКТ: согласование 25");
    expect(harness.activityState.activities.filter((activity) => activity.employeeId === employeeA.employeeId)).toHaveLength(6);
    expect(harness.activityState.activities.map((activity) => activity.activityDate)).toEqual([
      "2026-08-17", "2026-08-19", "2026-08-21", "2026-08-24", "2026-08-26", "2026-08-27", "2026-08-25",
    ]);
    // Every canonical row carries the research pseudonym, never the employee id.
    for (const activity of harness.activityState.activities) {
      const participant = harness.world.participants.find((candidate) => candidate.employeeId === activity.employeeId);
      expect(activity.subjectKey).toBe(participant?.subjectKey);
      expect(activity.subjectKey).not.toBe(activity.employeeId);
    }

    // 3. Scheduled daily prompts keep planning bounded but do not limit factual activity capture.
    await harness.application.runScheduledProcess({
      userId: employeeA.employeeId, threadId: "cycle", processId: "morning_planning",
    });
    await harness.application.runScheduledProcess({
      userId: employeeA.employeeId, threadId: "cycle", processId: "evening_reflection",
    });
    expect(harness.observed.scheduledPrompts).toHaveLength(2);
    expect(harness.observed.scheduledPrompts[0]).toContain("до трёх приоритетов");
    expect(harness.observed.scheduledPrompts[0]).toContain("все явно названные факты одним вызовом collectActivities");
    expect(harness.observed.scheduledPrompts[1]).toContain("без ограничения их количества");
    expect(harness.observed.scheduledPrompts[1]).toContain("одним вызовом collectActivities");
    expect(harness.observed.scheduledPrompts.join("\n")).not.toContain("до трёх фактически");

    // 4. The scheduled weekly checkpoint reads the employee's own seven days.
    const weeklyRun = await harness.application.runScheduledProcess({
      userId: employeeA.employeeId, threadId: "cycle", processId: "weekly_summary",
    });
    expect(weeklyRun.selectedProcessIds).toEqual(["core", "weekly_summary"]);
    expect(weeklyRun.effect).toBe("none");
    expect(harness.observed.weekly.at(-1)).toEqual({
      fromDate: "2026-08-22",
      toDate: "2026-08-28",
      activityCount: 3,
      activeDates: 3,
      sufficientData: true,
      taskCategories: [{ value: "reporting", count: 3 }],
      routinePatterns: [{ value: "manual_reporting", count: 1 }],
      automationCandidates: [{ value: "report_generation", count: 1 }],
      energyStressMarkers: [],
      durationBuckets: [],
      systems: [{ value: "spreadsheets", count: 1 }],
    });

    // 4. A rejected pattern changes nothing in the personal context.
    const rejected = await harness.application.chat({
      userId: employeeA.employeeId, threadId: "cycle", text: "Нет, это была разовая история",
    });
    expect(rejected.effect).toBe("none");
    expect(harness.world.profiles.find((profile) => profile.employeeId === employeeA.employeeId)?.typicalTasks)
      .toEqual(["Подготовка заявок"]);

    // 5. A confirmed pattern is written once and shown back by /context.
    const confirmed = await harness.application.chat({
      userId: employeeA.employeeId, threadId: "cycle", text: "Да, отчёт повторяется каждую неделю",
    });
    expect(confirmed.effect).toBe("business_write_committed");
    const afterConfirmation = await harness.application.getPersonalContext({ employeeId: employeeA.employeeId });
    expect(afterConfirmation.confirmedProfile.typicalTasks).toEqual(["Подготовка заявок", "еженедельный отчёт по продажам"]);

    await harness.telegram.showContext(identityA);
    const contextMessage = harness.telegram.sentMessages().at(-1)?.text ?? "";
    expect(contextMessage).toContain("Ваш подтверждённый профиль:");
    expect(contextMessage).toContain("еженедельный отчёт по продажам");
    expect(contextMessage).not.toMatch(/employee_a|default_company|default_group|default_role|telegram_employee_a/u);
    harness.telegram.clear();

    // 6. The final report describes only what repeated inside the cycle and
    //    writes neither an activity nor a profile field.
    const activitiesBefore = harness.activityState.activities.length;
    const profileBefore = structuredClone(harness.world.profiles.find((profile) => profile.employeeId === employeeA.employeeId));
    const finalRun = await harness.application.runScheduledProcess({
      userId: employeeA.employeeId, threadId: "cycle", processId: "final_report",
    });
    expect(finalRun.selectedProcessIds).toEqual(["core", "final_report"]);
    expect(finalRun.effect).toBe("none");
    expect(harness.observed.cycle.at(-1)).toMatchObject({
      fromDate: "2026-08-15",
      toDate: "2026-08-28",
      activityCount: 6,
      activeDates: 6,
      sufficientData: true,
      patternMinimumCount: 2,
      confirmedPatterns: {
        taskCategories: ["reporting"],
        routinePatterns: ["manual_reporting"],
        automationCandidates: [],
        energyStressMarkers: [],
        systems: ["spreadsheets"],
      },
    });
    expect(finalRun.response).toContain("reporting");
    expect(harness.activityState.activities).toHaveLength(activitiesBefore);
    expect(harness.world.profiles.find((profile) => profile.employeeId === employeeA.employeeId)).toEqual(profileBefore);

    // 7. Owner isolation: the second employee sees only their own thin week.
    const contextB = await harness.application.getPersonalContext({ employeeId: employeeB.employeeId });
    expect(contextB.confirmedProfile).toMatchObject({ preferredName: "Борис" });
    expect(contextB.confirmedProfile.typicalTasks).toBeUndefined();
    expect(JSON.stringify(contextB)).not.toMatch(/Анна|тендер|отчёт по продажам/u);
    await harness.application.runScheduledProcess({ userId: employeeB.employeeId, threadId: "cycle", processId: "weekly_summary" });
    expect(harness.observed.weekly.at(-1)).toMatchObject({
      activityCount: 1, activeDates: 1, sufficientData: false, taskCategories: [{ value: "coordination", count: 1 }],
    });
    await harness.application.runScheduledProcess({ userId: employeeB.employeeId, threadId: "cycle", processId: "final_report" });
    expect(harness.observed.cycle.at(-1)).toMatchObject({
      activityCount: 1,
      sufficientData: false,
      confirmedPatterns: { taskCategories: [], routinePatterns: [], automationCandidates: [], energyStressMarkers: [], systems: [] },
    });
  });

  it("keeps the personal result outside the company artifact and outside a neighbour purge", async () => {
    const harness = createHarness();
    const identityA = await onboard(harness, employeeA, { preferredName: "Анна", selfDescription: "Координирую тендеры" });
    await onboard(harness, employeeB, { preferredName: "Борис" });
    const identityC = await onboard(harness, employeeC, { preferredName: "Виктор" });
    for (const text of ["ФАКТ: отчёт вручную 17", "ФАКТ: отчёт вручную 19", "ФАКТ: встреча 21", "ФАКТ: отчёт можно автоматизировать 24", "ФАКТ: отчёт вручную 26", "ФАКТ: отчёт 27"]) {
      await sendFact(harness, identityA, text);
    }
    await sendFact(harness, identityC, "ФАКТ: согласование 25");

    const before = await harness.cycle.summarize({ employeeId: employeeA.employeeId, timezone });

    // The company artifact of the employee's own group carries no personal
    // result, no pseudonym and no employee id.
    const report = await harness.reporting.exportGroup({ companyId: employeeA.companyId, groupId: employeeA.groupId });
    const clientArtifact = JSON.stringify(report.client);
    for (const forbidden of ["employee_a", "employee_b", "subjectKey", "subject_", "Анна", "тендер", "Координирую"]) {
      expect(clientArtifact).not.toContain(forbidden);
    }

    // Purging the neighbouring company through the operator command removes
    // that scope and leaves the employee's own cycle result byte-identical.
    const output: string[] = [];
    await runResearchScopePurgeCommand(["--company", employeeC.companyId], {
      service: harness.purge,
      readConfirmation: async () => `PURGE COMPANY ${employeeC.companyId}`,
      write: (text) => output.push(text),
    });
    expect(output.join("")).toContain(`"confirmation": "PURGE COMPANY ${employeeC.companyId}"`);
    expect(output.join("")).toContain('"participants": 1');
    expect(harness.world.participants.map((participant) => participant.employeeId).sort())
      .toEqual([employeeA.employeeId, employeeB.employeeId]);
    await expect(harness.cycle.summarize({ employeeId: employeeA.employeeId, timezone })).resolves.toEqual(before);
    await expect(harness.application.getPersonalContext({ employeeId: employeeA.employeeId }))
      .resolves.toMatchObject({ confirmedProfile: { preferredName: "Анна" } });

    // Purging the employee's own group is a different, deliberate operation:
    // after it the personal source is gone, and the gate states that plainly.
    await harness.purge.purge({ companyId: employeeA.companyId, groupId: employeeA.groupId });
    await expect(harness.cycle.summarize({ employeeId: employeeA.employeeId, timezone }))
      .resolves.toMatchObject({ activityCount: 0, sufficientData: false });
  });

  it("arms the final report on a schedule, delivers it to Telegram, and runs it on demand", async () => {
    const harness = createHarness();
    const identityA = await onboard(harness, employeeA, { preferredName: "Анна" });
    for (const text of ["ФАКТ: отчёт вручную 17", "ФАКТ: отчёт вручную 19", "ФАКТ: встреча 21", "ФАКТ: отчёт можно автоматизировать 24", "ФАКТ: отчёт вручную 26", "ФАКТ: отчёт 27"]) {
      await sendFact(harness, identityA, text);
    }

    const arming = new FinalReportArmingService(harness.profileStore, harness.scheduleManagement);
    await expect(arming.arm({ companyId: employeeA.companyId, groupId: employeeA.groupId, timeOfDay: "17:00" }))
      .resolves.toMatchObject({ armed: 1, failed: 0 });
    await expect(harness.scheduleStore.get(employeeA.employeeId, `${employeeA.employeeId}:final_report-daily`))
      .resolves.toMatchObject({ kind: "process", processId: "final_report", oneShot: true, enabled: true, timeOfDay: "17:00", timezone, nextFireAt: "2026-08-29T14:00:00.000Z" });

    // The armed schedule fires once and its result reaches the employee's chat.
    harness.at("2026-08-29T14:00:00.000Z");
    const scheduler = new SchedulerService(
      harness.scheduleStore,
      { now: () => harness.now() },
      createTelegramScheduledActionRunner({
        assistant: harness.application,
        telegramSessionStore: harness.identityRuntime.telegramSessionStore,
        telegramShell: {
          deliverProactive: (chatId, result, employeeId) => harness.telegram.deliverProactive({ chatId, employeeId, result }),
          deliverReminder: (chatId, text, employeeId) => harness.telegram.deliverReminder({ chatId, employeeId, text }),
        },
      }),
    );
    harness.telegram.clear();
    // 2026-08-29 is a Saturday, so the weekday defaults stay silent; the overdue
    // Friday reflection and the armed one-shot are what is due.
    const fired = await scheduler.tick();
    expect(fired.map((fire) => fire.kind === "process" ? fire.processId : "reminder"))
      .toEqual(["evening_reflection", "final_report"]);
    const delivered = harness.telegram.sentMessages();
    expect(delivered.every((message) => message.chatId === identityA.chatId)).toBe(true);
    const finalDelivery = delivered.filter((message) => message.text.includes("Итог цикла"));
    expect(finalDelivery).toHaveLength(1);
    expect(finalDelivery[0]?.text).toContain("reporting");
    for (const message of delivered) {
      expect(message.text).not.toMatch(/employee_a|subject_|default_group|default_role/u);
    }
    // One shot: the same end of cycle does not arm a second final report.
    harness.telegram.clear();
    await expect(scheduler.tick()).resolves.toEqual([]);
    await expect(harness.scheduleStore.get(employeeA.employeeId, `${employeeA.employeeId}:final_report-daily`))
      .resolves.toMatchObject({ enabled: false });

    // The operator can also run the same process on demand for one participant.
    harness.at(lastCycleDay);
    const onDemand = await runScheduledProcessOnDemand(harness.application, {
      employeeId: employeeA.employeeId, processId: "final_report", threadId: "cycle",
    });
    expect(onDemand.selectedProcessIds).toEqual(["core", "final_report"]);
    expect(onDemand.response).toContain("Итог цикла");
    await expect(runScheduledProcessOnDemand(harness.application, {
      employeeId: "employee_unknown", processId: "final_report", threadId: "cycle",
    })).rejects.toThrow('employee "employee_unknown" was not found');
  });
});
