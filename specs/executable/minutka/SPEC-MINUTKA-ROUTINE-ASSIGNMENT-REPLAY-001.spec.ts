import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { RoutineAssignmentReplayService, type RoutineAssignmentReplayInput } from "../../../src/application/routine-assignment-replay.js";
import { createPostgresRoutineAssignmentReplayStore } from "../../../src/infrastructure/postgres/postgres-routine-assignment-replay-store.js";

const input: RoutineAssignmentReplayInput = {
  schemaVersion: "minutka-routine-assignment-replay/v1",
  companyId: "company_a",
  groupId: "group_a",
  source: { corpusExportedAt: "2026-09-04T10:15:59.635Z", directoryVersion: "2", reviewedBy: "methodologist" },
  assignments: [{ activityId: "activity_a", roleId: "role_a", routineId: "routine_a", routineLabel: "Подготовка отчёта" }],
};

describe("SPEC-MINUTKA-ROUTINE-ASSIGNMENT-REPLAY-001: reviewed historical routine repair", () => {
  it("validates unique exact assignments before opening storage", async () => {
    const service = new RoutineAssignmentReplayService({ async replay(value) { return { status: "applied", assignments: value.assignments.length, applied: value.assignments.length, alreadyApplied: 0 }; } });
    await expect(service.replay(input)).resolves.toMatchObject({ status: "applied", assignments: 1 });
    await expect(service.replay({ ...input, assignments: [...input.assignments, ...input.assignments] })).rejects.toThrow("duplicate activityId");
  });

  it("updates the exact scope and writes a revision in one transaction", async () => {
    const db = fakeDatabase([
      [{ source_message_id: "message_a", task_category: "reporting", routine_pattern: null, automation_candidate: null, energy_stress_marker: null, duration_bucket: "1_2h", system: "spreadsheets", recurrence: null, revision: 2, status: "active", superseded_by_activity_id: null }],
      [],
    ]);
    await expect(new RoutineAssignmentReplayService(createPostgresRoutineAssignmentReplayStore(db.pool)).replay(input))
      .resolves.toEqual({ status: "applied", assignments: 1, applied: 1, alreadyApplied: 0 });
    expect(db.queries.map(({ sql }) => sql.replace(/\s+/gu, " ").trim())).toEqual([
      "BEGIN",
      expect.stringContaining("UPDATE minutka_private.activities SET routine_id=$1"),
      expect.stringContaining("INSERT INTO minutka_private.activity_revisions"),
      "COMMIT",
    ]);
    expect(db.queries[1]?.values).toEqual(["routine_a", "Подготовка отчёта", "operator_replay:2026-09-04T10:15:59.635Z", "activity_a", "company_a", "group_a", "role_a"]);
  });

  it("is idempotent but rolls back on a conflicting canonical row", async () => {
    const idempotent = fakeDatabase([[], [{ routine_id: "routine_a", routine_label: "Подготовка отчёта" }]]);
    await expect(createPostgresRoutineAssignmentReplayStore(idempotent.pool).replay(input)).resolves.toEqual({ status: "already_applied", assignments: 1, applied: 0, alreadyApplied: 1 });

    const conflict = fakeDatabase([[], [{ routine_id: "routine_other", routine_label: "Другая рутина" }]]);
    await expect(createPostgresRoutineAssignmentReplayStore(conflict.pool).replay(input)).rejects.toThrow("conflicts with canonical activity");
    expect(conflict.queries.at(-1)?.sql).toBe("ROLLBACK");
  });
});

function fakeDatabase(rowSets: QueryResultRow[][]): { pool: Pool; queries: Array<{ sql: string; values?: unknown[] }> } {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let index = 0;
  const client = { query: async (sql: string, values?: unknown[]) => { queries.push({ sql, values }); if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return queryResult([]); return queryResult(rowSets[index++] ?? []); }, release: () => undefined } as unknown as PoolClient;
  return { pool: { connect: async () => client } as unknown as Pool, queries };
}

function queryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: "", oid: 0, fields: [] };
}
