import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import { CompanyReportingService } from "../../../src/application/company-reporting.js";
import {
  createInMemoryActivityCollectionState,
  createInMemoryActivityCollectionStore,
} from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryCompanyReportStore } from "../../../src/application/in-memory-company-report-store.js";
import {
  createInMemoryEvaluationCaseState,
  createInMemoryEvaluationCaseStore,
} from "../../../src/application/in-memory-evaluation-case-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryResearchScopePurgeStore } from "../../../src/application/in-memory-research-scope-purge-store.js";
import {
  createInMemoryResearchTraceState,
  createInMemoryResearchTraceStore,
} from "../../../src/application/in-memory-research-trace-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { evaluationCaseSchemaVersion } from "../../../src/application/research-evaluation.js";
import { ResearchScopePurgeService } from "../../../src/application/research-scope-purge.js";
import { researchTraceSchemaVersion } from "../../../src/application/research-trace-store.js";
import { createTenantSubjectScopeIndex } from "../../../src/application/tenant-subject-scope.js";
import { runResearchScopePurgeCommand } from "../../../src/runtime/research-scope-purge-command.js";

const now = "2026-08-19T09:00:00.000Z";

const subjects = [
  { employeeId: "emp_a1_one", companyId: "company_a", groupId: "group_a1" },
  { employeeId: "emp_a1_two", companyId: "company_a", groupId: "group_a1" },
  { employeeId: "emp_a2_one", companyId: "company_a", groupId: "group_a2" },
  { employeeId: "emp_b1_one", companyId: "company_b", groupId: "group_b1" },
] as const;

type Fixture = Awaited<ReturnType<typeof createFixture>>;

async function createFixture() {
  const world = createInMemoryWorld(() => now);
  const tenantScope = createTenantSubjectScopeIndex();
  const activityState = createInMemoryActivityCollectionState();
  const traceState = createInMemoryResearchTraceState();
  const evaluationState = createInMemoryEvaluationCaseState();
  let subjectCounter = 0;
  const profiles = createInMemoryProfileStore(world, { subjectKey: () => `subject_${++subjectCounter}` });
  const activities = new CollectActivityService(
    createInMemoryActivityCollectionStore(activityState, { tenantScope }),
    { now: () => now },
    () => `activity_${subjectCounter}_${activityState.activities.length}`,
  );
  const traces = createInMemoryResearchTraceStore(traceState, { tenantScope });
  const evaluations = createInMemoryEvaluationCaseStore(evaluationState, { tenantScope });

  for (const subject of subjects) {
    const { participant } = await profiles.issueInvite({
      ...subject,
      inviteCode: `invite_${subject.employeeId}`,
      issuedAt: now,
    });
    const scope = { companyId: subject.companyId, groupId: subject.groupId, subjectKey: participant.subjectKey };
    world.messages.push({
      id: `message_${subject.employeeId}`,
      employeeId: subject.employeeId,
      subjectKey: participant.subjectKey,
      threadId: `thread_${subject.employeeId}`,
      text: "утренний чек-ин",
      response: "ok",
      timestamp: now,
    });
    world.feedback.push({
      id: `feedback_${subject.employeeId}`,
      employeeId: subject.employeeId,
      threadId: `thread_${subject.employeeId}`,
      targetMessageId: `message_${subject.employeeId}`,
      rating: "positive",
      source: "telegram",
      createdAt: now,
      updatedAt: now,
    });
    world.auditEvents.push({
      id: `audit_${subject.employeeId}`,
      requestId: `request_${subject.employeeId}`,
      type: "chat_received",
      employeeId: subject.employeeId,
      occurredAt: now,
      metadata: {},
    });
    await activities.collect({
      employeeId: subject.employeeId,
      ...scope,
      roleId: "role_one",
      timezone: "Etc/UTC",
      activity: { taskCategory: "reporting" },
    });
    await traces.append({
      schemaVersion: researchTraceSchemaVersion,
      traceId: `trace_${subject.employeeId}`,
      requestId: `request_${subject.employeeId}`,
      messageId: `message_${subject.employeeId}`,
      ...scope,
      processIds: ["core"],
      promptVersion: "prompt/v1",
      processVersion: "process/v1",
      taxonomyVersion: "taxonomy/v1",
      model: "openai/test",
      samplingRate: 1,
      input: { text: "утренний чек-ин", modality: "text" },
      attempts: [{ attempt: 1, context: "bounded", modelSteps: [], toolCalls: [], toolResults: [] }],
      output: "ok",
      startedAt: now,
      completedAt: now,
      latencyMs: 0,
      status: "completed",
    });
    await evaluations.create({
      schemaVersion: evaluationCaseSchemaVersion,
      caseId: `case_${subject.employeeId}`,
      ...scope,
      traceId: `trace_${subject.employeeId}`,
      requestId: `request_${subject.employeeId}`,
      messageId: `message_${subject.employeeId}`,
      promptVersion: "prompt/v1",
      processVersion: "process/v1",
      taxonomyVersion: "taxonomy/v1",
      model: "openai/test",
      labels: { usefulness: "useful", accuracy: "accurate", clarification: "not_needed", extractionCorrectness: "correct" },
      createdAt: now,
    });
  }

  const purgedObjectOwners: string[] = [];
  const service = new ResearchScopePurgeService(
    createInMemoryResearchScopePurgeStore({
      world,
      activities: activityState,
      traces: traceState,
      evaluationCases: evaluationState,
    }),
    {
      async deleteByEmployee(employeeId) {
        purgedObjectOwners.push(employeeId);
        return { deletedObjectVersions: 2 };
      },
    },
  );
  return { world, profiles, activityState, traceState, evaluationState, purgedObjectOwners, service };
}

function remaining(fixture: Fixture) {
  return {
    participants: fixture.world.participants.map((participant) => participant.employeeId).sort(),
    messages: fixture.world.messages.map((message) => message.employeeId).sort(),
    feedback: fixture.world.feedback.map((record) => record.employeeId).sort(),
    activities: fixture.activityState.activities.map((activity) => activity.employeeId).sort(),
    traces: fixture.traceState.traces.map((trace) => trace.traceId).sort(),
    evaluationCases: fixture.evaluationState.cases.map((record) => record.caseId).sort(),
  };
}

function report(fixture: Fixture, groupId: string) {
  return new CompanyReportingService(
    createInMemoryCompanyReportStore({ participants: fixture.world.participants, activities: fixture.activityState }),
    () => now,
  ).exportGroup({ companyId: "company_a", groupId });
}

describe("SPEC-MINUTKA-RESEARCH-SCOPE-PURGE-001: operator company and group purge", () => {
  it("previews the exact group scope without deleting anything", async () => {
    const fixture = await createFixture();

    await expect(fixture.service.preview({ companyId: "company_a", groupId: " group_a1 " })).resolves.toMatchObject({
      scope: { kind: "group", companyId: "company_a", groupId: "group_a1" },
      counts: { participants: 2, messages: 2, activities: 2, traces: 2, evaluationCases: 2, feedback: 2, auditEvents: 2 },
      confirmation: "PURGE GROUP company_a/group_a1",
    });
    await expect(fixture.service.preview({ companyId: "company_a" })).resolves.toMatchObject({
      scope: { kind: "company", companyId: "company_a" },
      counts: { participants: 3, messages: 3, activities: 3, traces: 3, evaluationCases: 3 },
      confirmation: "PURGE COMPANY company_a",
    });
    await expect(fixture.service.preview({ companyId: "company_unknown" })).rejects.toThrow("research_scope_not_found");
    expect(remaining(fixture).participants).toEqual(["emp_a1_one", "emp_a1_two", "emp_a2_one", "emp_b1_one"]);
    expect(fixture.purgedObjectOwners).toEqual([]);
  });

  it("purges one group and leaves the sibling group of the same company intact", async () => {
    const fixture = await createFixture();

    await expect(fixture.service.purge({ companyId: "company_a", groupId: "group_a1" })).resolves.toMatchObject({
      scope: { kind: "group", companyId: "company_a", groupId: "group_a1" },
      deleted: { participants: 2, messages: 2, activities: 2, traces: 2, evaluationCases: 2, minioObjectVersions: 4 },
      preserved: { anonymousPurgeAudit: true, tenantReferenceDirectories: "kept", deliveredClientArtifacts: "not_recalled" },
      oldInvitesRevoked: true,
    });

    expect(fixture.purgedObjectOwners).toEqual(["emp_a1_one", "emp_a1_two"]);
    expect(remaining(fixture)).toEqual({
      participants: ["emp_a2_one", "emp_b1_one"],
      messages: ["emp_a2_one", "emp_b1_one"],
      feedback: ["emp_a2_one", "emp_b1_one"],
      activities: ["emp_a2_one", "emp_b1_one"],
      traces: ["trace_emp_a2_one", "trace_emp_b1_one"],
      evaluationCases: ["case_emp_a2_one", "case_emp_b1_one"],
    });
    // Old invites of the purged scope stop working; the sibling group keeps its own.
    await expect(fixture.profiles.openInvite({ inviteCode: "invite_emp_a1_one", openedAt: now })).resolves.toBeUndefined();
    await expect(fixture.profiles.openInvite({ inviteCode: "invite_emp_a2_one", openedAt: now })).resolves.toBeDefined();
    // Report recompute reads the corpus that is still there.
    await expect(report(fixture, "group_a2")).resolves.toMatchObject({
      internal: { coverage: { invitedParticipants: 1, contributors: 1, observations: 1 } },
    });
    await expect(report(fixture, "group_a1")).resolves.toMatchObject({
      internal: { coverage: { invitedParticipants: 0, contributors: 0, observations: 0 } },
      client: { coverage: { assessment: "insufficient" } },
    });
  });

  it("purges one company and leaves another company intact", async () => {
    const fixture = await createFixture();

    await expect(fixture.service.purge({ companyId: "company_a" })).resolves.toMatchObject({
      scope: { kind: "company", companyId: "company_a" },
      deleted: { participants: 3, messages: 3, activities: 3, traces: 3, evaluationCases: 3, minioObjectVersions: 6 },
    });

    expect(remaining(fixture)).toEqual({
      participants: ["emp_b1_one"],
      messages: ["emp_b1_one"],
      feedback: ["emp_b1_one"],
      activities: ["emp_b1_one"],
      traces: ["trace_emp_b1_one"],
      evaluationCases: ["case_emp_b1_one"],
    });
    await expect(fixture.service.purge({ companyId: "company_a" })).rejects.toThrow("research_scope_not_found");
  });

  it("keeps an identity-free audit record with scope, counts and outcome", async () => {
    const fixture = await createFixture();

    await fixture.service.purge({ companyId: "company_a", groupId: "group_a1" });

    const audit = fixture.world.auditEvents.at(-1)!;
    expect(audit).toMatchObject({
      type: "research_scope_purged",
      metadata: {
        scope: "group",
        companyId: "company_a",
        groupId: "group_a1",
        outcome: "purged",
        participants: 2,
        messages: 2,
        activities: 2,
        traces: 2,
        feedback: 2,
        evaluationCases: 2,
        auditEvents: 2,
        objectVersions: 4,
      },
    });
    expect(audit).not.toHaveProperty("employeeId");
    // Employee-linked audit rows of the purged scope are gone; the sibling groups keep theirs.
    expect(fixture.world.auditEvents.map((record) => record.employeeId).filter(Boolean).sort())
      .toEqual(["emp_a2_one", "emp_b1_one"]);
    const auditText = JSON.stringify(fixture.world.auditEvents);
    for (const forbidden of ["subject_1", "subject_2", "emp_a1_one", "emp_a1_two", "утренний чек-ин"]) {
      expect(auditText).not.toContain(forbidden);
    }
  });

  it("purges only after the exact typed confirmation and never on preview", async () => {
    const fixture = await createFixture();
    const output: string[] = [];
    const run = (argv: string[], confirmation: string) => runResearchScopePurgeCommand(argv, {
      service: fixture.service,
      readConfirmation: async () => confirmation,
      write: (text) => output.push(text),
    });

    await run(["--company", "company_a", "--group", "group_a1", "--preview"], "PURGE GROUP company_a/group_a1");
    expect(output.join("")).toContain("\"confirmation\": \"PURGE GROUP company_a/group_a1\"");
    expect(remaining(fixture).participants).toHaveLength(4);

    await expect(run(["--company", "company_a", "--group", "group_a1"], "PURGE COMPANY company_a"))
      .rejects.toThrow("confirmation did not match; nothing was purged");
    expect(remaining(fixture).participants).toHaveLength(4);
    expect(fixture.purgedObjectOwners).toEqual([]);

    await run(["--company", "company_a", "--group", "group_a1"], " PURGE GROUP company_a/group_a1 ");
    expect(remaining(fixture).participants).toEqual(["emp_a2_one", "emp_b1_one"]);
  });

  it("documents only the commands the runtime actually exposes", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const runbook = readFileSync("docs/runbooks/research-scope-purge.md", "utf8");
    const researchRunbook = readFileSync("docs/runbooks/research-corpus-and-evaluation.md", "utf8");
    const employeeRunbook = readFileSync("docs/runbooks/employee-personal-data-deletion.md", "utf8");

    expect(packageJson.scripts["research:scope:purge"]).toBe("tsx src/runtime/purge-research-scope.ts");
    expect(runbook).toContain("npm run research:scope:purge -- --company <company_id> --preview");
    expect(runbook).toContain("npm run research:scope:purge -- --company <company_id>");
    expect(runbook).toContain("npm run research:scope:purge -- --company <company_id> --group <group_id>");
    expect(runbook).toContain("PURGE COMPANY <company_id>");
    expect(runbook).toContain("PURGE GROUP <company_id>/<group_id>");
    expect(runbook).toContain("confirmation did not match; nothing was purged");
    // The research and employee runbooks point at the same typed commands.
    expect(researchRunbook).toContain("research:scope:purge");
    expect(researchRunbook).toContain("employee:data:delete");
    expect(employeeRunbook).toContain("research-scope-purge.md");
  });
});
