import { describe, expect, it } from "vitest";
import { ResearchCorpusExportService } from "../../../src/application/research-corpus-export.js";
import { createInMemoryEvaluationCaseState, createInMemoryEvaluationCaseStore } from "../../../src/application/in-memory-evaluation-case-store.js";
import { createInMemoryResearchTraceState, createInMemoryResearchTraceStore } from "../../../src/application/in-memory-research-trace-store.js";
import { ResearchEvaluationService } from "../../../src/application/research-evaluation.js";
import { researchTraceSchemaVersion } from "../../../src/application/research-trace-store.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { runResearchCorpusCommand } from "../../../src/runtime/research-corpus-command.js";

const now = "2026-08-18T21:00:00.000Z";
const trace = (overrides: Partial<ReturnType<typeof baseTrace>> = {}) => ({ ...baseTrace(), ...overrides });
function baseTrace() {
  return {
    schemaVersion: researchTraceSchemaVersion,
    traceId: "trace-a",
    requestId: "request-a",
    messageId: "message-a",
    companyId: "company-a",
    groupId: "group-a",
    subjectKey: "subject-a",
    processIds: ["core"],
    promptVersion: "prompt/v2",
    processVersion: "process/v3",
    taxonomyVersion: "taxonomy/v4",
    model: "openai/test",
    samplingRate: 1 as const,
    input: { text: "Исследовательский текст", modality: "text" as const },
    attempts: [{ attempt: 1, context: "bounded context", modelSteps: [], toolCalls: [], toolResults: [] }],
    output: "Ответ",
    startedAt: now,
    completedAt: now,
    latencyMs: 0,
    status: "completed" as const,
  };
}

function source() {
  return {
    async listSubjects({ companyId, groupId }: { companyId: string; groupId: string }) {
      return companyId === "company-a" && groupId === "group-a" ? [{ companyId, groupId, subjectKey: "subject-a", roleId: "role-a", evidenceRefs: [{ kind: "message" as const, id: "message-a" }, { kind: "activity" as const, id: "activity-a" }, { kind: "trace" as const, id: "trace-a" }] }] : [];
    },
    async listMessages({ companyId, groupId }: { companyId: string; groupId: string }) {
      return companyId === "company-a" && groupId === "group-a" ? [
        { messageId: "message-a", subjectKey: "subject-a", userText: "Текст A, invite_code=super-secret", agentResponse: "Ответ A", timestamp: now },
        { messageId: "message-without-trace", subjectKey: "subject-a", userText: "Текст без trace", agentResponse: "Ответ", timestamp: now },
      ] : [];
    },
    async listActivities({ companyId, groupId }: { companyId: string; groupId: string }) {
      return companyId === "company-a" && groupId === "group-a" ? [{ activityId: "activity-a", subjectKey: "subject-a", companyId, groupId, roleId: "role-a", taskCategory: "reporting" as const, activityDate: "2026-08-18", recordedAt: now }] : [];
    },
    async listFeedback({ companyId, groupId }: { companyId: string; groupId: string }) {
      return companyId === "company-a" && groupId === "group-a" ? [{ feedbackId: "feedback-a", targetMessageId: "message-a", rating: "positive" as const, createdAt: now, updatedAt: now }] : [];
    },
  };
}

describe("SPEC-MINUTKA-RESEARCH-CORPUS-001: scoped evidence export and evaluation", () => {
  it("links corpus records, exposes missing traces, renders all formats, and audits counts without payload", async () => {
    const traces = createInMemoryResearchTraceStore(createInMemoryResearchTraceState());
    await traces.append(trace());
    await traces.append(trace({ traceId: "trace-b", requestId: "request-b", messageId: "message-b", companyId: "company-b", groupId: "group-b", subjectKey: "subject-b" }));
    const evaluationState = createInMemoryEvaluationCaseState();
    const evaluations = createInMemoryEvaluationCaseStore(evaluationState);
    const evaluation = new ResearchEvaluationService(evaluations, traces, { now: () => now }, () => "case-a");
    await evaluation.create({
      companyId: "company-a", groupId: "group-a", traceId: "trace-a",
      labels: { usefulness: "useful", accuracy: "accurate", clarification: "not_needed", extractionCorrectness: "correct", notes: "Проверено человеком" },
    });
    const world = createInMemoryWorld(() => now);
    const service = new ResearchCorpusExportService(source(), traces, evaluations, createInMemoryAuditEventStore(world), { now: () => now }, () => "audit-export");

    const json = await service.export({ companyId: "company-a", groupId: "group-a", format: "json" });
    expect(json.corpus.coverage).toMatchObject({ subjects: 1, messages: 2, activities: 1, traces: 1, feedback: 1, evaluationCases: 1, messagesWithTrace: 1, messagesMissingTrace: 1 });
    expect(json.corpus.messages[0]).toMatchObject({ trace: { status: "present", traceId: "trace-a", requestId: "request-a" }, feedback: [{ feedbackId: "feedback-a", rating: "positive" }] });
    expect(json.corpus.messages[1]?.trace).toEqual({ status: "missing" });
    expect(JSON.stringify(json.corpus)).not.toMatch(/employeeId|threadId|telegram/iu);
    expect(JSON.stringify(json.corpus)).not.toContain("super-secret");
    expect(JSON.stringify(json.corpus)).toContain("invite_code=[REDACTED]");
    expect(JSON.stringify(json.corpus)).not.toContain("company-b");
    expect(JSON.parse(json.content).versions).toEqual({ prompts: ["prompt/v2"], processes: ["process/v3"], taxonomies: ["taxonomy/v4"], models: ["openai/test"] });
    expect((await service.export({ companyId: "company-a", groupId: "group-a", format: "jsonl" })).content).toContain('"recordType":"evaluation_case"');
    expect((await service.export({ companyId: "company-a", groupId: "group-a", format: "markdown" })).content).toContain("Messages missing trace: 1");

    const audit = world.auditEvents[0]!;
    expect(audit).toMatchObject({ type: "research_corpus_exported", metadata: { companyId: "company-a", groupId: "group-a", outcome: "succeeded", messages: 2, traces: 1 } });
    expect(JSON.stringify(audit)).not.toContain("Текст A");
    expect(JSON.stringify(audit)).not.toContain("subject-a");
  });

  it("creates and reads evaluation cases only from a trace in the exact scope", async () => {
    const traces = createInMemoryResearchTraceStore(createInMemoryResearchTraceState());
    await traces.append(trace());
    const store = createInMemoryEvaluationCaseStore(createInMemoryEvaluationCaseState());
    const evaluations = new ResearchEvaluationService(store, traces, { now: () => now }, () => "case-a");
    const created = await evaluations.create({ companyId: "company-a", groupId: "group-a", traceId: "trace-a", labels: { usefulness: "partly_useful", accuracy: "partly_accurate", clarification: "needed", extractionCorrectness: "partly_correct" } });
    expect(created).toMatchObject({ caseId: "case-a", subjectKey: "subject-a", traceId: "trace-a", requestId: "request-a", messageId: "message-a", promptVersion: "prompt/v2", taxonomyVersion: "taxonomy/v4" });
    await expect(evaluations.get({ companyId: "company-a", groupId: "group-a", caseId: "case-a" })).resolves.toEqual(created);
    await expect(evaluations.get({ companyId: "company-b", groupId: "group-b", caseId: "case-a" })).resolves.toBeUndefined();
    await expect(evaluations.create({ companyId: "company-a", groupId: "group-wrong", traceId: "trace-a", labels: created.labels })).rejects.toThrow("research trace not found");
  });

  it("provides operator CLI commands for export and evaluation workflow", async () => {
    const writes: string[] = [];
    const traces = createInMemoryResearchTraceStore(createInMemoryResearchTraceState());
    await traces.append(trace());
    const store = createInMemoryEvaluationCaseStore(createInMemoryEvaluationCaseState());
    const evaluationService = new ResearchEvaluationService(store, traces, { now: () => now }, () => "case-cli");
    const exportService = new ResearchCorpusExportService(source(), traces, store, undefined, { now: () => now });
    await runResearchCorpusCommand(["evaluation", "create", "--company", "company-a", "--group", "group-a", "--trace", "trace-a", "--usefulness", "useful", "--accuracy", "accurate", "--clarification", "not_needed", "--extraction", "correct"], { exportService, evaluationService, write: (text) => writes.push(text) });
    await runResearchCorpusCommand(["evaluation", "get", "--company", "company-a", "--group", "group-a", "--case", "case-cli"], { exportService, evaluationService, write: (text) => writes.push(text) });
    await runResearchCorpusCommand(["export", "--company", "company-a", "--group", "group-a", "--format", "jsonl"], { exportService, evaluationService, write: (text) => writes.push(text) });
    expect(writes[0]).toContain('"caseId": "case-cli"');
    expect(writes[1]).toContain('"traceId": "trace-a"');
    expect(writes[2]).toContain('"recordType":"manifest"');
  });
});
