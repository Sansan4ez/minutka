import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import {
  createInMemoryActivityCollectionState,
  createInMemoryActivityCollectionStore,
} from "../../../src/application/in-memory-activity-collection-store.js";
import { CompanyReportingService } from "../../../src/application/company-reporting.js";
import { PersistenceOutcomeUnknownError } from "../../../src/application/persistence-error.js";

const cleanupMigrationPath = "migrations/0060_remove_anonymized_activity_contour.sql";
const evidenceLinkMigrationPath = "migrations/0061_link_activity_source_message_without_insert_order.sql";

describe("SPEC-MINUTKA-CANONICAL-ACTIVITY-WRITE-001: one subject-aware activity record", () => {
  it("writes exactly one canonical activity with subject and source-message links", async () => {
    const state = createInMemoryActivityCollectionState();
    const service = new CollectActivityService(
      createInMemoryActivityCollectionStore(state),
      { now: () => "2026-08-15T22:17:35.000Z" },
      () => "activity_one",
    );

    await service.collect({
      employeeId: "employee_a",
      subjectKey: "subject_employee_a",
      sourceMessageId: "message_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      timezone: "Europe/Moscow",
      activity: {
        taskCategory: "reporting",
        routinePattern: "manual_reporting",
        durationBucket: "1_2h",
        system: "spreadsheets",
      },
    });

    expect(state.activities).toEqual([{
      activityId: "activity_one",
      employeeId: "employee_a",
      subjectKey: "subject_employee_a",
      sourceMessageId: "message_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      taskCategory: "reporting",
      obstacle: { kind: "routine_pattern", value: "manual_reporting" },
      durationBucket: "1_2h",
      system: "spreadsheets",
      activityDate: "2026-08-16",
      recordedAt: "2026-08-15T22:17:35.000Z",
    }]);
  });

  // The contract schema cannot forbid a second obstacle without losing the whole
  // call, so a model that answers through several lenses at once still reaches
  // the store. The seam that broke the pilot run is here: exactly one obstacle
  // is stored, chosen by the fixed routine -> automation -> energy order.
  it("keeps one obstacle in the fixed order when a call carries several lenses", async () => {
    const state = createInMemoryActivityCollectionState();
    let index = 0;
    const service = new CollectActivityService(
      createInMemoryActivityCollectionStore(state),
      { now: () => "2026-08-15T12:00:00.000Z" },
      () => `activity_${++index}`,
    );
    const scope = {
      employeeId: "employee_a",
      subjectKey: "subject_employee_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      timezone: "Europe/Moscow",
    };

    for (const activity of [
      { taskCategory: "reporting", routinePattern: "manual_reporting", automationCandidate: "report_generation", energyStressMarker: "fatigue" },
      { taskCategory: "reporting", automationCandidate: "report_generation", energyStressMarker: "fatigue" },
      { taskCategory: "reporting", energyStressMarker: "fatigue" },
      { taskCategory: "reporting" },
    ] as const) {
      await service.collect({ ...scope, activity });
    }

    expect(state.activities.map((activity) => activity.obstacle)).toEqual([
      { kind: "routine_pattern", value: "manual_reporting" },
      { kind: "automation_candidate", value: "report_generation" },
      { kind: "energy_stress_marker", value: "fatigue" },
      undefined,
    ]);
  });

  it("validates the whole batch before writing and reports a mid-batch storage failure", async () => {
    const invalidState = createInMemoryActivityCollectionState();
    const invalidService = new CollectActivityService(
      createInMemoryActivityCollectionStore(invalidState),
      { now: () => "2026-08-15T22:17:35.000Z" },
      () => "activity_invalid",
    );

    await expect(invalidService.collectBatch({
      employeeId: "employee_a",
      subjectKey: "subject_employee_a",
      sourceMessageId: "message_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      timezone: "Europe/Moscow",
      activities: [{ taskCategory: "reporting" }, { taskCategory: "not_in_dictionary" as never }],
    })).rejects.toThrow();
    expect(invalidState.activities).toEqual([]);

    const partialState = createInMemoryActivityCollectionState();
    let writes = 0;
    let ids = 0;
    const partialService = new CollectActivityService(
      createInMemoryActivityCollectionStore(partialState, { failWrite: () => ++writes === 3 }),
      { now: () => "2026-08-15T22:17:35.000Z" },
      () => `activity_partial_${++ids}`,
    );

    await expect(partialService.collectBatch({
      employeeId: "employee_a",
      subjectKey: "subject_employee_a",
      sourceMessageId: "message_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      timezone: "Europe/Moscow",
      activities: [
        { taskCategory: "reporting" },
        { taskCategory: "meetings" },
        { taskCategory: "coordination" },
        { taskCategory: "focus_work" },
      ],
    })).resolves.toMatchObject({ status: "partial", savedCount: 2, activityIds: ["activity_partial_1", "activity_partial_2"] });
    expect(partialState.activities).toHaveLength(2);
  });

  it("reconciles a committed activity after an unknown persistence outcome without retrying the write", async () => {
    const state = createInMemoryActivityCollectionState();
    let writes = 0;
    const service = new CollectActivityService({
      async saveActivity(activity) {
        writes += 1;
        state.activities.push(structuredClone(activity));
        throw new PersistenceOutcomeUnknownError();
      },
      async getActivityById(activityId) {
        const activity = state.activities.find((candidate) => candidate.activityId === activityId);
        return activity ? structuredClone(activity) : undefined;
      },
    }, { now: () => "2026-08-15T22:17:35.000Z" }, () => "activity_recovered");

    await expect(service.collectBatch({
      employeeId: "employee_a",
      subjectKey: "subject_employee_a",
      sourceMessageId: "message_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      timezone: "Europe/Moscow",
      activities: [{ taskCategory: "reporting", system: "spreadsheets" }],
    })).resolves.toEqual({ status: "completed", savedCount: 1, activityIds: ["activity_recovered"] });
    expect(writes).toBe(1);
    expect(state.activities).toHaveLength(1);
  });

  it("does not treat a different exact-id record as successful reconciliation", async () => {
    let writes = 0;
    const service = new CollectActivityService({
      async saveActivity() {
        writes += 1;
        throw new PersistenceOutcomeUnknownError();
      },
      async getActivityById(activityId) {
        return {
          activityId,
          employeeId: "employee_a",
          subjectKey: "subject_employee_a",
          sourceMessageId: "message_a",
          companyId: "company_a",
          groupId: "group_a",
          roleId: "role_a",
          taskCategory: "meetings",
          activityDate: "2026-08-16",
          recordedAt: "2026-08-15T22:17:35.000Z",
        };
      },
    }, { now: () => "2026-08-15T22:17:35.000Z" }, () => "activity_conflict");

    await expect(service.collect({
      employeeId: "employee_a",
      subjectKey: "subject_employee_a",
      sourceMessageId: "message_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      timezone: "Europe/Moscow",
      activity: { taskCategory: "reporting" },
    })).rejects.toBeInstanceOf(PersistenceOutcomeUnknownError);
    expect(writes).toBe(1);
  });

  it("propagates an unknown persistence outcome when exact-id reconciliation cannot prove the write", async () => {
    for (const uncertainWrite of [1, 3]) {
      const state = createInMemoryActivityCollectionState();
      let writes = 0;
      let ids = 0;
      const service = new CollectActivityService({
        async saveActivity(activity) {
          writes += 1;
          if (writes === uncertainWrite) throw new PersistenceOutcomeUnknownError();
          state.activities.push(structuredClone(activity));
        },
        async getActivityById(activityId) {
          const activity = state.activities.find((candidate) => candidate.activityId === activityId);
          return activity ? structuredClone(activity) : undefined;
        },
      }, { now: () => "2026-08-15T22:17:35.000Z" }, () => `activity_uncertain_${++ids}`);

      await expect(service.collectBatch({
        employeeId: "employee_a",
        subjectKey: "subject_employee_a",
        sourceMessageId: "message_a",
        companyId: "company_a",
        groupId: "group_a",
        roleId: "role_a",
        timezone: "Europe/Moscow",
        activities: [
          { taskCategory: "reporting" },
          { taskCategory: "meetings" },
          { taskCategory: "coordination" },
        ],
      })).rejects.toBeInstanceOf(PersistenceOutcomeUnknownError);
      expect(state.activities).toHaveLength(uncertainWrite - 1);
    }
  });

  it("does not expose a partial record when the canonical write fails", async () => {
    const state = createInMemoryActivityCollectionState();
    const service = new CollectActivityService(
      createInMemoryActivityCollectionStore(state, { failWrite: () => true }),
      { now: () => "2026-08-15T22:17:35.000Z" },
      () => "activity_failed",
    );

    await expect(service.collect({
      employeeId: "employee_a",
      subjectKey: "subject_employee_a",
      sourceMessageId: "message_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      timezone: "Europe/Moscow",
      activity: { routinePattern: "manual_reporting" },
    })).rejects.toThrow("canonical activity write failed");
    expect(state.activities).toEqual([]);
  });

  it("drops only the superseded reporting table and preserves canonical stores", () => {
    const migration = readFileSync(cleanupMigrationPath, "utf8");
    expect(migration).toContain("DROP TABLE minutka_reporting.anonymized_activities");
    expect(migration).toContain("DROP SCHEMA minutka_reporting");
    expect(migration).not.toMatch(/DROP TABLE minutka_private\.(?:activities|messages)/u);
    expect(migration).not.toMatch(/DROP TABLE minutka_research\.(?:traces|evaluation_cases)/u);
  });

  it("keeps subject/activity refs inside research evidence and outside the client DTO", async () => {
    const reporting = new CompanyReportingService({
      async loadGroupSnapshot() {
        return {
          invitedParticipants: 1,
          subjects: [{ subjectKey: "subject_employee_a", roleId: "role_a" }],
          activities: [{
            activityId: "activity_one",
            subjectKey: "subject_employee_a",
            companyId: "company_a",
            groupId: "group_a",
            roleId: "role_a",
            taskCategory: "reporting" as const,
            obstacle: { kind: "routine_pattern" as const, value: "manual_reporting" as const },
            activityDate: "2026-08-16",
            recordedAt: "2026-08-15T22:17:35.000Z",
          }],
        };
      },
    });
    const { internal, client } = await reporting.exportGroup({ companyId: "company_a", groupId: "group_a" });
    expect(JSON.stringify(internal)).toContain("subject_employee_a");
    expect(JSON.stringify(internal)).toContain("activity_one");
    expect(JSON.stringify(client)).not.toMatch(/subject_|employee_|message_a|activity_one|evidenceRefs/u);
  });

  it("keeps the single PostgreSQL insert behind the outcome-aware transaction boundary", () => {
    const source = readFileSync("src/infrastructure/postgres/postgres-activity-collection-store.ts", "utf8");
    expect(source.match(/withTransaction\(/gu)).toHaveLength(1);
    expect(source.match(/INSERT INTO minutka_private\.activities/gu)).toHaveLength(1);
  });

  // The tool writes the activity inside the agent loop, long before the turn's
  // message row exists, so the evidence link cannot be an insert-time foreign
  // key. Owner and subject of the link are guarded in the write itself instead.
  it("stores the source-message link without requiring the conversation row first", () => {
    const migration = readFileSync(evidenceLinkMigrationPath, "utf8");
    expect(migration).toContain("DROP CONSTRAINT activities_source_message_fk");
    expect(migration).not.toMatch(/REFERENCES minutka_private\.messages/u);
    const source = readFileSync("src/infrastructure/postgres/postgres-activity-collection-store.ts", "utf8");
    expect(source).toContain("WHERE NOT EXISTS");
    expect(source).toContain("FROM minutka_private.messages message");
    expect(source).toContain("PersistenceError(\"persistence_conflict\")");
  });

  it("contains no legacy dual-write or retention symbols in live source", () => {
    const source = [
      readFileSync("src/application/activity-collection.ts", "utf8"),
      readFileSync("src/application/in-memory-activity-collection-store.ts", "utf8"),
      readFileSync("src/infrastructure/postgres/postgres-activity-collection-store.ts", "utf8"),
      readFileSync("package.json", "utf8"),
    ].join("\n");
    expect(source).not.toMatch(/AnonymizedActivityRecord|saveActivityPair|company:anonymized:purge|anonymized_activities/u);
  });
});
