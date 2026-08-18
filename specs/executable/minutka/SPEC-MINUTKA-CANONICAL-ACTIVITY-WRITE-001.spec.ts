import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import {
  createInMemoryActivityCollectionState,
  createInMemoryActivityCollectionStore,
} from "../../../src/application/in-memory-activity-collection-store.js";
import { CompanyReportingService } from "../../../src/application/company-reporting.js";

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
