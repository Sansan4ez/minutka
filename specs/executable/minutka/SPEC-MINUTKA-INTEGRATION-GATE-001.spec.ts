import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssistantService, type AssistantAgentRunner } from "../../../src/application/assistant-service.js";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import { CompanyReportingService } from "../../../src/application/company-reporting.js";
import { createInMemoryActivityCollectionState, createInMemoryActivityCollectionStore } from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryCompanyReportStore } from "../../../src/application/in-memory-company-report-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryEvaluationCaseState, createInMemoryEvaluationCaseStore } from "../../../src/application/in-memory-evaluation-case-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryResearchTraceState, createInMemoryResearchTraceStore } from "../../../src/application/in-memory-research-trace-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { ResearchCorpusExportService, type ResearchCorpusSource } from "../../../src/application/research-corpus-export.js";
import { ResearchEvaluationService } from "../../../src/application/research-evaluation.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { createInMemoryRuntime, executableSpecPrivacyExplanation } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { TelegramDriver } from "../support/telegram-driver.js";

const now = "2026-08-18T21:30:00.000Z";
const traceVersions = {
  promptVersion: "prompt/integration-v1",
  processVersion: "process/integration-v1",
  taxonomyVersion: "taxonomy/integration-v1",
  model: "deterministic/integration",
};

type GateHarness = ReturnType<typeof createGateHarness>;

type ParticipantSpec = {
  employeeId: string;
  companyId: string;
  groupId: string;
  roleId: string;
  subjectKey: string;
};

function createGateHarness() {
  const clock = { now: () => now };
  const world = createInMemoryWorld(clock.now);
  world.tenantDirectories.groups.push(
    { id: "group_a", companyId: "company_a" },
    { id: "group_b", companyId: "company_b" },
  );
  world.tenantDirectories.roles.push(
    { id: "role_a", companyId: "company_a", name: "Аналитик" },
    { id: "role_b", companyId: "company_b", name: "Оператор" },
  );
  const identityRuntime = createInMemoryRuntime({ world, agentRunner: async () => "unused" });
  const profileStore = createInMemoryProfileStore(world);
  const activityState = createInMemoryActivityCollectionState();
  let activityId = 0;
  const activities = new CollectActivityService(
    createInMemoryActivityCollectionStore(activityState),
    clock,
    () => `activity_${++activityId}`,
  );
  const traceState = createInMemoryResearchTraceState();
  const traces = createInMemoryResearchTraceStore(traceState);
  const evaluationStore = createInMemoryEvaluationCaseStore(createInMemoryEvaluationCaseState());
  const evaluations = new ResearchEvaluationService(evaluationStore, traces, clock, () => "evaluation_gate");
  const warnings: unknown[] = [];
  const documents = createInMemoryDocumentStore(clock);
  const runner: AssistantAgentRunner = async (input, context) => {
    if (input.text.startsWith("ACTIVITY:")) {
      context.markProcessUsed("evening_reflection");
      await context.collectActivities({ activities: [{
        taskCategory: "reporting",
        routinePattern: "manual_reporting",
        durationBucket: "30_60m",
        system: "spreadsheets",
      }] });
    }
    return {
      text: `Ответ: ${input.text}`,
      executionTrace: [],
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      trace: { model: traceVersions.model, modelSteps: [{ text: input.text }], toolCalls: [], toolResults: [] },
    };
  };
  const assistantChat = new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(world),
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock) }),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    participantStore: profileStore,
    collectActivities: (command) => activities.collectBatch(command),
    researchTraceStore: traces,
    researchTraceVersions: traceVersions,
    auditEventStore: createInMemoryAuditEventStore(world),
    operationalLogger: (warning) => warnings.push(warning),
    clock,
    idGenerator: createDeterministicIdGenerator(),
  });
  const reporting = new CompanyReportingService(
    createInMemoryCompanyReportStore({ participants: world.participants, activities: activityState }),
    clock.now,
  );
  const artifactStore = createInMemoryArtifactStore({
    contentStore: createInMemoryArtifactContentStore(clock),
    clock,
    limits: { maximumBytes: 1_000_000, timeoutMs: 1_000 },
  });
  const application = new PersonalAssistantService(
    identityRuntime.service,
    assistantChat,
    artifactStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    reporting,
  );
  const telegram = new TelegramDriver(world, async () => "unused", {}, true, undefined, {
    ...identityRuntime,
    service: application,
  });
  const corpusSource: ResearchCorpusSource = {
    listSubjects: (scope) => identityRuntime.service.listResearchSubjects(scope),
    async listMessages({ companyId, groupId }) {
      const subjects = new Set(
        world.participants
          .filter((participant) => participant.companyId === companyId && participant.groupId === groupId)
          .map((participant) => participant.subjectKey),
      );
      return world.messages
        .filter((message) => message.subjectKey && subjects.has(message.subjectKey))
        .map((message) => ({
          messageId: message.id,
          subjectKey: message.subjectKey!,
          userText: message.text,
          agentResponse: message.response,
          timestamp: message.timestamp,
        }));
    },
    async listActivities({ companyId, groupId }) {
      return activityState.activities
        .filter((activity) => activity.companyId === companyId && activity.groupId === groupId)
        .map(({ employeeId: _employeeId, ...activity }) => structuredClone(activity));
    },
    async listFeedback({ companyId, groupId }) {
      const employees = new Set(
        world.participants
          .filter((participant) => participant.companyId === companyId && participant.groupId === groupId)
          .map((participant) => participant.employeeId),
      );
      return world.feedback
        .filter((feedback) => employees.has(feedback.employeeId))
        .map((feedback) => ({
          feedbackId: feedback.id,
          targetMessageId: feedback.targetMessageId,
          rating: feedback.rating,
          createdAt: feedback.createdAt,
          updatedAt: feedback.updatedAt,
        }));
    },
  };
  const corpus = new ResearchCorpusExportService(
    corpusSource,
    traces,
    evaluationStore,
    createInMemoryAuditEventStore(world),
    clock,
    () => "audit_export_gate",
  );

  return { world, identityRuntime, application, telegram, profileStore, activityState, traces, traceState, evaluations, corpus, reporting, warnings };
}

async function onboardThroughTelegram(harness: GateHarness, participant: ParticipantSpec) {
  await harness.identityRuntime.service.issueInvite({
    employeeId: participant.employeeId,
    inviteCode: `invite_${participant.employeeId}`,
    companyId: participant.companyId,
    groupId: participant.groupId,
  });
  const stored = harness.world.participants.find((candidate) => candidate.employeeId === participant.employeeId);
  if (!stored) throw new Error("participant was not created");
  stored.subjectKey = participant.subjectKey;
  const chatId = `chat_${participant.employeeId}`;
  const userId = `telegram_${participant.employeeId}`;
  await harness.telegram.start({ chatId, userId, inviteCode: `invite_${participant.employeeId}` });
  const consentMessage = harness.telegram.sentMessages().at(-1);
  expect(consentMessage?.text).toBe(executableSpecPrivacyExplanation);
  const consentCallback = consentMessage?.replyMarkup?.inlineKeyboard[0]?.[0]?.callbackData;
  if (!consentCallback || consentMessage?.messageId === undefined) throw new Error("privacy-v6 consent action was not rendered");
  await harness.telegram.clickCallback({ chatId, userId, callbackData: consentCallback, messageId: consentMessage.messageId });
  await harness.application.completeOnboarding({
    employeeId: participant.employeeId,
    roleId: participant.roleId,
    preferredName: participant.employeeId,
    persona: "efficiency",
    responseLength: "short",
    timezone: "Etc/UTC",
  });
  expect(harness.world.consents).toContainEqual(expect.objectContaining({
    employeeId: participant.employeeId,
    privacyVersion: "privacy-v6",
    source: "telegram",
  }));
  return { chatId, userId };
}

async function sendActivity(harness: GateHarness, participant: ParticipantSpec, text: string) {
  const identity = await onboardThroughTelegram(harness, participant);
  harness.telegram.clear();
  await harness.telegram.sendText({ ...identity, text: `ACTIVITY:${text}` });
  return harness.world.messages.find((message) => message.employeeId === participant.employeeId && message.text === `ACTIVITY:${text}`)!;
}

function forbiddenClientArtifactTerms(participants: ParticipantSpec[], messages: string[], traces: string[]) {
  return [
    ...participants.flatMap(({ employeeId, subjectKey }) => [employeeId, subjectKey]),
    ...messages,
    ...traces,
    "employeeId",
    "subjectKey",
    "evidenceRefs",
    "identityMapping",
    "input",
    "attempts",
    "toolCalls",
    "toolResults",
  ];
}

describe("SPEC-MINUTKA-INTEGRATION-GATE-001: Telegram corpus to evidence and client report", () => {
  it("runs two tenant-isolated Telegram/application paths through evidence export, evaluation, confidence, and the client boundary", async () => {
    const harness = createGateHarness();
    const companyAParticipants: ParticipantSpec[] = [
      { employeeId: "employee_a1", companyId: "company_a", groupId: "group_a", roleId: "role_a", subjectKey: "subject_a1" },
      { employeeId: "employee_a2", companyId: "company_a", groupId: "group_a", roleId: "role_a", subjectKey: "subject_a2" },
      { employeeId: "employee_a3", companyId: "company_a", groupId: "group_a", roleId: "role_a", subjectKey: "subject_a3" },
    ];
    const companyBParticipant: ParticipantSpec = {
      employeeId: "employee_b1", companyId: "company_b", groupId: "group_b", roleId: "role_b", subjectKey: "subject_b1",
    };

    const firstMessage = await sendActivity(harness, companyAParticipants[0]!, "private report alpha day one");
    for (const [participant, text] of [
      [companyAParticipants[0]!, "private report alpha day two"],
      [companyAParticipants[1]!, "private report beta day two"],
      [companyAParticipants[1]!, "private report beta day three"],
      [companyAParticipants[2]!, "private report gamma day three"],
    ] as const) {
      const identity = { chatId: `chat_${participant.employeeId}`, userId: `telegram_${participant.employeeId}` };
      if (!harness.world.profiles.some((profile) => profile.employeeId === participant.employeeId)) await onboardThroughTelegram(harness, participant);
      harness.telegram.clear();
      await harness.telegram.sendText({ ...identity, text: `ACTIVITY:${text}` });
    }
    const companyBMessage = await sendActivity(harness, companyBParticipant, "private company b only");

    const firstTrace = (await harness.traces.list({ companyId: "company_a", groupId: "group_a" }))
      .find((trace) => trace.messageId === firstMessage.id);
    if (!firstTrace) throw new Error("company A trace missing");
    await harness.evaluations.create({
      companyId: "company_a",
      groupId: "group_a",
      traceId: firstTrace.traceId,
      labels: { usefulness: "useful", accuracy: "accurate", clarification: "not_needed", extractionCorrectness: "correct" },
    });

    const [companyAJson, companyAJsonl, companyBJson, companyAReport, companyBReport] = await Promise.all([
      harness.corpus.export({ companyId: "company_a", groupId: "group_a", format: "json" }),
      harness.corpus.export({ companyId: "company_a", groupId: "group_a", format: "jsonl" }),
      harness.corpus.export({ companyId: "company_b", groupId: "group_b", format: "json" }),
      harness.reporting.exportGroup({ companyId: "company_a", groupId: "group_a" }),
      harness.reporting.exportGroup({ companyId: "company_b", groupId: "group_b" }),
    ]);

    expect(companyAJson.corpus.coverage).toMatchObject({ subjects: 3, messages: 5, activities: 5, traces: 5, evaluationCases: 1, messagesMissingTrace: 0 });
    expect(companyAJsonl.content).toContain('"recordType":"evaluation_case"');
    expect(companyAJsonl.content).toContain('"recordType":"activity"');
    expect(companyAJson.content).not.toContain(companyBParticipant.subjectKey);
    expect(companyAJson.content).not.toContain(companyBParticipant.employeeId);
    expect(companyAJson.content).not.toContain(companyBMessage.text);
    expect(companyBJson.content).not.toContain("subject_a1");
    expect(companyBJson.content).not.toContain("employee_a1");
    expect(companyAReport.internal.coverage).toMatchObject({ contributors: 3, observations: 5, activeDates: 1 });
    expect(companyAReport.internal.buckets.find((bucket) => bucket.scope.kind === "overall_group")).toMatchObject({
      contributors: 3,
      observations: 5,
      confidence: "signal",
    });
    expect(companyBReport.internal.coverage).toMatchObject({ contributors: 1, observations: 1 });
    expect(companyBReport.internal.buckets.find((bucket) => bucket.scope.kind === "overall_group")).toMatchObject({ confidence: "hypothesis" });

    const clientArtifact = JSON.stringify(companyAReport.client);
    for (const forbidden of forbiddenClientArtifactTerms(
      [...companyAParticipants, companyBParticipant],
      harness.world.messages.map((message) => message.text),
      harness.traceState.traces.map((trace) => JSON.stringify(trace)),
    )) expect(clientArtifact).not.toContain(forbidden);
    expect(clientArtifact).not.toContain("company_b");
  });

  it("counts one subject once even across twenty canonical observations", async () => {
    const harness = createGateHarness();
    const participant = { employeeId: "employee_single", companyId: "company_a", groupId: "group_a", roleId: "role_a", subjectKey: "subject_single" } satisfies ParticipantSpec;
    await sendActivity(harness, participant, "single contributor observation 1");
    const template = harness.activityState.activities[0]!;
    template.activityDate = "2026-08-01";
    for (let index = 2; index <= 20; index += 1) {
      harness.activityState.activities.push({
        ...structuredClone(template),
        activityId: `activity_single_${index}`,
        activityDate: `2026-08-${String(1 + ((index - 1) % 4)).padStart(2, "0")}`,
      });
    }

    const report = await harness.reporting.exportGroup({ companyId: "company_a", groupId: "group_a" });
    expect(report.internal.coverage).toMatchObject({ contributors: 1, observations: 20, activeDates: 4 });
    expect(report.internal.buckets.find((bucket) => bucket.scope.kind === "overall_group")).toMatchObject({
      contributors: 1,
      observations: 20,
      activeDates: 4,
      confidence: "signal",
    });
  });

  it("preserves the Telegram conversation and exposes a missing marker when trace persistence drops", async () => {
    const harness = createGateHarness();
    const participant = { employeeId: "employee_drop", companyId: "company_a", groupId: "group_a", roleId: "role_a", subjectKey: "subject_drop" } satisfies ParticipantSpec;
    const identity = await onboardThroughTelegram(harness, participant);
    const failingTraces = createInMemoryResearchTraceStore(harness.traceState, { failAppend: () => true });
    const documents = createInMemoryDocumentStore({ now: () => now });
    const warnings: unknown[] = [];
    const assistant = new AssistantService(async () => "Ответ сохранён без trace.", {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(harness.world),
      ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: () => now }) }),
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      participantStore: harness.profileStore,
      researchTraceStore: failingTraces,
      researchTraceVersions: traceVersions,
      auditEventStore: createInMemoryAuditEventStore(harness.world),
      operationalLogger: (warning) => warnings.push(warning),
      clock: { now: () => now },
      idGenerator: createDeterministicIdGenerator(),
    });
    const failingApplication = new PersonalAssistantService(
      harness.identityRuntime.service,
      assistant,
      createInMemoryArtifactStore({
        contentStore: createInMemoryArtifactContentStore({ now: () => now }),
        clock: { now: () => now },
        limits: { maximumBytes: 1_000_000, timeoutMs: 1_000 },
      }),
    );
    const telegram = new TelegramDriver(harness.world, async () => "unused", {}, true, undefined, {
      ...harness.identityRuntime,
      service: failingApplication,
    });
    await telegram.sendText({ ...identity, text: "conversation with dropped trace" });

    const message = harness.world.messages.find((candidate) => candidate.employeeId === participant.employeeId && candidate.text === "conversation with dropped trace");
    expect(message).toMatchObject({ response: "Ответ сохранён без trace." });
    expect(warnings).toContainEqual(expect.objectContaining({ type: "research_trace_missing", status: "completed" }));
    expect(harness.world.auditEvents).toContainEqual(expect.objectContaining({ type: "trace_missing" }));

    const exported = await harness.corpus.export({ companyId: "company_a", groupId: "group_a", format: "json" });
    expect(exported.corpus.messages.find((candidate) => candidate.messageId === message?.id)?.trace).toEqual({ status: "missing" });
    expect(exported.corpus.coverage).toMatchObject({ messagesMissingTrace: 1 });
  });

  it("keeps privacy-v6 active and the superseded anonymized contour absent", () => {
    expect(readFileSync("src/domain/privacy.ts", "utf8")).toContain('currentPrivacyVersion = "privacy-v6"');
    const migration = readFileSync("migrations/0060_remove_anonymized_activity_contour.sql", "utf8");
    expect(migration).toContain("DROP TABLE minutka_reporting.anonymized_activities");
    const liveSources = [
      "src/application/activity-collection.ts",
      "src/application/company-reporting.ts",
      "src/application/research-corpus-export.ts",
      "src/infrastructure/postgres/postgres-activity-collection-store.ts",
      "src/infrastructure/postgres/postgres-company-report-store.ts",
      "src/infrastructure/postgres/postgres-research-corpus-source.ts",
    ].map((path) => readFileSync(path, "utf8")).join("\n");
    expect(liveSources).not.toMatch(/AnonymizedActivityRecord|saveActivityPair|anonymized_activities/u);
  });
});
