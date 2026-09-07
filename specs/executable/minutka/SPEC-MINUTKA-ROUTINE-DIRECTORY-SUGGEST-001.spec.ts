import { describe, expect, it } from "vitest";
import type { PersonalActivityRecord } from "../../../src/application/activity-collection.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryEvaluationCaseState, createInMemoryEvaluationCaseStore } from "../../../src/application/in-memory-evaluation-case-store.js";
import { createInMemoryResearchTraceState, createInMemoryResearchTraceStore } from "../../../src/application/in-memory-research-trace-store.js";
import { ResearchEvidenceReadService } from "../../../src/application/research-evidence-read.js";
import { RoutineDirectorySuggestService, type RoutineDirectorySuggestionGenerator } from "../../../src/application/routine-directory-suggest.js";
import type { RoutineDirectory } from "../../../src/application/routine-directory.js";
import { buildRoutineDirectorySuggestPrompt } from "../../../src/mastra/routine-directory-suggester.js";
import { routineKey } from "../../../src/application/own-activity-window.js";

const now = "2026-09-07T12:00:00.000Z";

const directory: RoutineDirectory = {
  schemaVersion: "minutka-routine-directory/v1",
  companyId: "company-a",
  version: "1",
  sections: [{
    roleId: "sales",
    entries: [{
      id: "routine-report",
      name: "Подготовка отчётов",
      description: "Подготовка регулярных отчётов",
      examples: ["Сводка показателей"],
      quickWin: "report_template",
      provenance: [{ groupId: "group-a", subjectKey: "subject-a" }],
    }],
  }],
};

const activity = (overrides: Partial<PersonalActivityRecord>): Omit<PersonalActivityRecord, "employeeId"> => ({
  activityId: "activity-free",
  subjectKey: "subject-a",
  sourceMessageId: "message-a",
  companyId: "company-a",
  groupId: "group-a",
  roleId: "sales",
  routineLabel: "Prepare reports",
  activityDate: "2026-09-07",
  recordedAt: now,
  status: "active",
  ...overrides,
});

function evidenceSource() {
  return {
    async listMessages() {
      return [{
        messageId: "message-a",
        subjectKey: "subject-a",
        userText: "I prepare reports every Friday",
        agentResponse: "Спасибо",
        timestamp: now,
      }];
    },
    async listActivities() {
      return [
        activity({ activityId: "activity-free" }),
        activity({ activityId: "activity-free-2", routineLabel: " prepare, reports " }),
        activity({ activityId: "activity-attached", routineId: "routine-report", routineLabel: "Подготовка отчётов" }),
      ];
    },
  };
}

function service(
  generate: RoutineDirectorySuggestionGenerator,
  auditWorld: ReturnType<typeof createAuditWorld> = createAuditWorld(),
) {
  const traces = createInMemoryResearchTraceStore(createInMemoryResearchTraceState());
  const evaluations = createInMemoryEvaluationCaseStore(createInMemoryEvaluationCaseState());
  const reads = new ResearchEvidenceReadService(
    evaluations,
    traces,
    createInMemoryAuditEventStore(auditWorld),
    { now: () => now },
    () => "audit-read",
    evidenceSource(),
  );
  return { service: new RoutineDirectorySuggestService(reads, generate), auditWorld };
}

function createAuditWorld() {
  return {
    auditEvents: [],
    events: [],
  } as unknown as Parameters<typeof createInMemoryAuditEventStore>[0];
}

describe("SPEC-MINUTKA-ROUTINE-DIRECTORY-SUGGEST-001: free labels review pack", () => {
  it("passes only free routines to the generator, validates attachments, and records a scoped research read", async () => {
    let received: Parameters<RoutineDirectorySuggestionGenerator>[0] | undefined;
    const { service: suggest, auditWorld } = service(async (input) => {
      received = input;
      return {
        routineKey: routineKey("Prepare reports"),
        proposal: { kind: "attach", routineId: "routine-report" },
        supportingPhrase: "prepare reports",
      };
    });

    const pack = await suggest.suggest({ companyId: "company-a", groupId: "group-a", directory });
    expect(received?.freeRoutines).toEqual([expect.objectContaining({ routineKey: "prepare reports", observations: 2, contributors: 1 })]);
    expect(received?.freeRoutines[0]?.messages).toEqual(["I prepare reports every Friday"]);
    expect(JSON.stringify(received?.freeRoutines)).not.toContain("routine-report");
    expect(pack.roles[0]?.suggestions[0]).toEqual({
      routineKey: "prepare reports",
      counts: { observations: 2, contributors: 1, activeDates: 1 },
      proposal: { kind: "attach", routineId: "routine-report" },
      supportingPhrase: "prepare reports",
      supportingPhraseStatus: "ok",
    });
    expect(JSON.stringify(pack)).not.toMatch(/subjectKey|message-a|I prepare reports every Friday/iu);
    expect(auditWorld.auditEvents).toContainEqual(expect.objectContaining({
      type: "research_evidence_read",
      metadata: { companyId: "company-a", groupId: "group-a", operation: "routine_evidence_list", outcome: "succeeded", count: 3 },
    }));
  });

  it("rejects an attachment outside the role directory and marks unsupported phrases", async () => {
    const { service: invalidAttach } = service(async () => ({
      routineKey: "prepare reports",
      proposal: { kind: "attach", routineId: "unknown" },
      supportingPhrase: "I prepare reports every Friday",
    }));
    await expect(invalidAttach.suggest({ companyId: "company-a", groupId: "group-a", directory })).rejects.toThrow("unknown routine id");

    const { service: invalidPhrase } = service(async () => ({
      routineKey: "prepare reports",
      proposal: { kind: "free" },
      supportingPhrase: "not present in evidence",
    }));
    const pack = await invalidPhrase.suggest({ companyId: "company-a", groupId: "group-a", directory });
    expect(pack.roles[0]?.suggestions[0]).toMatchObject({ supportingPhraseStatus: "no_supporting_phrase" });
    expect(pack.roles[0]?.suggestions[0]).not.toHaveProperty("supportingPhrase");
  });

  it("keeps the model prompt bounded to free routines and propagates generator errors before producing output", async () => {
    const prompt = buildRoutineDirectorySuggestPrompt({
      roleId: "sales",
      roleSection: { version: directory.version, entries: [] },
      catalog: [{ id: "report_template", typicalFor: "reports", title: "Report template" }],
      freeRoutines: [{ routineKey: "prepare reports", observations: 1, contributors: 1, activeDates: 1, messages: ["I prepare reports"] }],
    });
    expect(prompt).toContain("prepare reports");
    expect(prompt).not.toContain("routine-report");

    const { service: failing } = service(async () => { throw new Error("generator unavailable"); });
    await expect(failing.suggest({ companyId: "company-a", groupId: "group-a", directory })).rejects.toThrow("generator unavailable");
  });
});
