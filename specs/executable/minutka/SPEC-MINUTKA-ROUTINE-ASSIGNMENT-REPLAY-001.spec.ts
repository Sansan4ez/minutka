import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  RoutineAssignmentReplayError,
  RoutineAssignmentReplayService,
  type RoutineAssignmentReplayInput,
  type RoutineAssignmentReplayStore,
} from "../../../src/application/routine-assignment-replay.js";
import type { RoutineDirectory } from "../../../src/application/routine-directory.js";
import { createPostgresRoutineAssignmentReplayStore } from "../../../src/infrastructure/postgres/postgres-routine-assignment-replay-store.js";
import { parseRoutineAssignmentReplayArguments } from "../../../src/runtime/replay-routine-assignments.js";

const input: RoutineAssignmentReplayInput = {
  schemaVersion: "minutka-routine-assignment-replay/v1",
  companyId: "company_a",
  groupId: "group_a",
  source: { corpusExportedAt: "2026-09-04T10:15:59.635Z", directoryVersion: "2", reviewedBy: "methodologist" },
  assignments: [{ activityId: "activity_a", roleId: "role_a", routineId: "routine_a", routineLabel: "Подготовка отчёта" }],
};

const directory: RoutineDirectory = {
  schemaVersion: "minutka-routine-directory/v1",
  companyId: "company_a",
  version: "2",
  sections: [
    { roleId: "role_a", entries: [{ id: "routine_a", name: "Подготовка отчёта", description: "Готовит отчёт", examples: [], quickWin: "report_template", provenance: [{ groupId: "group_a", subjectKey: "subject_a" }] }] },
    { roleId: "role_b", entries: [{ id: "routine_b", name: "Проверка договора", description: "Проверяет договор", examples: [], quickWin: "deep_dive", provenance: [{ groupId: "group_a", subjectKey: "subject_b" }] }] },
  ],
};

describe("SPEC-MINUTKA-ROUTINE-ASSIGNMENT-REPLAY-001: reviewed historical routine repair", () => {
  it("validates the whole pack against the exact directory before opening storage", async () => {
    const replay = vi.fn<RoutineAssignmentReplayStore["replay"]>(async (value) => ({ status: "applied", assignments: value.assignments.length, applied: value.assignments.length, alreadyApplied: 0 }));
    const service = new RoutineAssignmentReplayService({ replay });
    await expect(service.replay(input, directory)).resolves.toMatchObject({ status: "applied", assignments: 1 });
    await expect(service.replay({ ...input, assignments: [...input.assignments, ...input.assignments] }, directory)).rejects.toThrow("duplicate activityId");
    await expect(service.replay(input, { ...directory, version: "3" })).rejects.toMatchObject({ code: "directory_version_mismatch" } satisfies Partial<RoutineAssignmentReplayError>);
    await expect(service.replay({ ...input, assignments: [{ ...input.assignments[0]!, routineId: "missing" }] }, directory)).rejects.toMatchObject({ code: "directory_routine_missing" } satisfies Partial<RoutineAssignmentReplayError>);
    await expect(service.replay({ ...input, assignments: [{ ...input.assignments[0]!, routineId: "routine_b" }] }, directory)).rejects.toMatchObject({ code: "directory_routine_missing" } satisfies Partial<RoutineAssignmentReplayError>);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("requires both the reviewed pack and directory CLI arguments", () => {
    expect(parseRoutineAssignmentReplayArguments(["--directory", "directory.json", "--file", "pack.json"])).toEqual({
      file: expect.stringMatching(/pack\.json$/u),
      directory: expect.stringMatching(/directory\.json$/u),
    });
    expect(() => parseRoutineAssignmentReplayArguments(["--file", "pack.json"])).toThrow("--directory");
  });

  it("updates the exact scope, preserves correction message id, writes a message-free revision and audits counts", async () => {
    const db = fakeDatabase([
      [{ task_category: "reporting", routine_pattern: null, automation_candidate: null, energy_stress_marker: null, duration_bucket: "1_2h", system: "spreadsheets", recurrence: null, revision: 2, status: "active", superseded_by_activity_id: null }],
      [],
      [],
    ]);
    await expect(new RoutineAssignmentReplayService(createPostgresRoutineAssignmentReplayStore(db.pool)).replay(input, directory))
      .resolves.toEqual({ status: "applied", assignments: 1, applied: 1, alreadyApplied: 0 });
    const normalized = db.queries.map(({ sql }) => sql.replace(/\s+/gu, " ").trim());
    expect(normalized).toEqual([
      "BEGIN",
      expect.stringContaining("UPDATE minutka_private.activities SET routine_id=$1"),
      expect.stringContaining("INSERT INTO minutka_private.activity_revisions"),
      expect.stringContaining("INSERT INTO minutka_audit.events"),
      "COMMIT",
    ]);
    expect(normalized[1]).not.toContain("last_correction_message_id");
    expect(normalized[2]).toContain("'corrected',NULL");
    expect(db.queries[1]?.values).toEqual(["routine_a", "Подготовка отчёта", "activity_a", "company_a", "group_a", "role_a"]);
    const auditMetadata = JSON.parse(String(db.queries[3]?.values?.[2])) as Record<string, unknown>;
    expect(auditMetadata).toEqual({ scope: "company_a/group_a", directoryVersion: "2", corpusExportedAt: "2026-09-04T10:15:59.635Z", assignments: 1, applied: 1, alreadyApplied: 0 });
    expect(JSON.stringify(db.queries)).not.toContain("operator_replay:");
  });

  it("is idempotent and audits the repeated run but rolls back on a conflicting canonical row", async () => {
    const idempotent = fakeDatabase([[], [{ routine_id: "routine_a", routine_label: "Подготовка отчёта" }], []]);
    await expect(new RoutineAssignmentReplayService(createPostgresRoutineAssignmentReplayStore(idempotent.pool)).replay(input, directory))
      .resolves.toEqual({ status: "already_applied", assignments: 1, applied: 0, alreadyApplied: 1 });
    expect(JSON.parse(String(idempotent.queries[3]?.values?.[2]))).toMatchObject({ applied: 0, alreadyApplied: 1 });

    const conflict = fakeDatabase([[], [{ routine_id: "routine_other", routine_label: "Другая рутина" }]]);
    await expect(new RoutineAssignmentReplayService(createPostgresRoutineAssignmentReplayStore(conflict.pool)).replay(input, directory)).rejects.toThrow("conflicts with canonical activity");
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
