import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import {
  createInMemoryActivityCollectionState,
  createInMemoryActivityCollectionStore,
} from "../../../src/application/in-memory-activity-collection-store.js";
import { withTransaction } from "../../../src/infrastructure/postgres/postgres-pool.js";

const migrationPath = "migrations/0047_create_activity_dual_write.sql";

function tableBody(sql: string, table: string): string {
  const escaped = table.replaceAll(".", "\\.");
  const match = sql.match(new RegExp(`CREATE TABLE ${escaped} \\(([\\s\\S]*?)\\n\\);`, "u"));
  if (!match?.[1]) throw new Error(`table not found: ${table}`);
  return match[1];
}

describe("SPEC-MINUTKA-ACTIVITY-DUAL-WRITE-001: atomic anonymized trace", () => {
  it("keeps the anonymized table structurally unlinkable to a user", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const body = tableBody(sql, "minutka_reporting.anonymized_activities");

    expect(body).not.toMatch(/\b(?:user|employee|participant|subject)(?:_|\b)/iu);
    expect(body).not.toMatch(/REFERENCES\s+minutka_private\.(?:participants|profiles|messages|threads|activities)/iu);
    expect(body).not.toContain("activity_id");
  });

  it("contains only structured fields and a date without a timestamp", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const body = tableBody(sql, "minutka_reporting.anonymized_activities");
    const columnNames = [...body.matchAll(/^\s{2}([a-z_]+)\s+/gmu)].map((match) => match[1]);

    expect(columnNames).toEqual([
      "company_id",
      "group_id",
      "role_id",
      "task_category",
      "obstacle_kind",
      "obstacle_value",
      "duration_bucket",
      "system",
      "activity_date",
    ]);
    expect(body).toContain("activity_date date NOT NULL");
    expect(body).not.toMatch(/\b(?:label|rationale|interferes_with|interferesWith|timestamp|created_at|recorded_at)\b/u);
    expect(body).not.toMatch(/\b(?:timestamp|timestamptz|json|jsonb)\b/iu);
  });

  it("writes exactly one personal row and one anonymized row per activity", async () => {
    const state = createInMemoryActivityCollectionState();
    const service = new CollectActivityService(
      createInMemoryActivityCollectionStore(state),
      { now: () => "2026-08-15T22:17:35.000Z" },
      () => "activity_one",
    );

    const collectForEmployee = service.bind({
      employeeId: "employee_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
    });
    await collectForEmployee({
      taskCategory: "reporting",
      routinePattern: "manual_reporting",
      durationBucket: "1_2h",
      system: "spreadsheets",
    });

    expect(state.personalActivities).toHaveLength(1);
    expect(state.anonymizedActivities).toEqual([{
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      taskCategory: "reporting",
      obstacle: { kind: "routine_pattern", value: "manual_reporting" },
      durationBucket: "1_2h",
      system: "spreadsheets",
      date: "2026-08-15",
    }]);
    expect(state.anonymizedActivities[0]).not.toHaveProperty("employeeId");
    expect(state.anonymizedActivities[0]).not.toHaveProperty("activityId");
    expect(state.anonymizedActivities[0]).not.toHaveProperty("recordedAt");
  });

  it("rolls back the personal write when the anonymized write fails", async () => {
    const state = createInMemoryActivityCollectionState();
    const service = new CollectActivityService(
      createInMemoryActivityCollectionStore(state, { failAnonymizedWrite: () => true }),
      { now: () => "2026-08-15T22:17:35.000Z" },
      () => "activity_rollback",
    );

    await expect(service.collect({
      employeeId: "employee_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      activity: { routinePattern: "manual_reporting" },
    })).rejects.toThrow("anonymized activity write failed");

    expect(state.personalActivities).toEqual([]);
    expect(state.anonymizedActivities).toEqual([]);
  });

  it("does not fan one activity out when category and obstacle coexist", async () => {
    const state = createInMemoryActivityCollectionState();
    const service = new CollectActivityService(
      createInMemoryActivityCollectionStore(state),
      { now: () => "2026-08-15T22:17:35.000Z" },
      () => "activity_combined",
    );

    await service.collect({
      employeeId: "employee_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      activity: {
        taskCategory: "reporting",
        automationCandidate: "report_generation",
      },
    });
    expect(state.personalActivities).toHaveLength(1);
    expect(state.anonymizedActivities).toEqual([expect.objectContaining({
      taskCategory: "reporting",
      obstacle: { kind: "automation_candidate", value: "report_generation" },
    })]);
  });

  it("distinguishes a rejected write from an unobserved commit", async () => {
    const rejected = new Error("constraint rejected");
    const rejectedClient = transactionClient(async (sql) => {
      if (sql === "INSERT") throw rejected;
    });
    await expect(withTransaction(transactionPool(rejectedClient), async (client) => {
      await client.query("INSERT");
    })).rejects.toBe(rejected);
    expect(rejectedClient.queries).toEqual(["BEGIN", "INSERT", "ROLLBACK"]);

    const deferredConstraint = Object.assign(new Error("deferred constraint rejected"), { code: "23514" });
    const commitRejectedClient = transactionClient(async (sql) => {
      if (sql === "COMMIT") throw deferredConstraint;
    });
    await expect(withTransaction(transactionPool(commitRejectedClient), async (client) => {
      await client.query("INSERT");
    })).rejects.toBe(deferredConstraint);
    expect(commitRejectedClient.queries).toEqual(["BEGIN", "INSERT", "COMMIT"]);

    const commitLost = new Error("connection lost after COMMIT was sent");
    const uncertainClient = transactionClient(async (sql) => {
      if (sql === "COMMIT") throw commitLost;
    });
    await expect(withTransaction(transactionPool(uncertainClient), async (client) => {
      await client.query("INSERT");
    })).rejects.toMatchObject({
      name: "PersistenceOutcomeUnknownError",
      cause: commitLost,
    });
    expect(uncertainClient.queries).toEqual(["BEGIN", "INSERT", "COMMIT"]);
  });

  it("uses one transaction for both PostgreSQL inserts", () => {
    const source = readFileSync("src/infrastructure/postgres/postgres-activity-collection-store.ts", "utf8");
    expect(source.match(/withTransaction\(/gu)).toHaveLength(1);
    expect(source).toContain("INSERT INTO minutka_private.activities");
    expect(source).toContain("INSERT INTO minutka_reporting.anonymized_activities");
  });
});

function transactionClient(onQuery: (sql: string) => Promise<void>): PoolClient & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query(sql: string) {
      queries.push(sql);
      await onQuery(sql);
      return { rows: [], rowCount: 0 };
    },
    release() {},
  } as unknown as PoolClient & { queries: string[] };
}

function transactionPool(client: PoolClient): Pool {
  return { async connect() { return client; } } as unknown as Pool;
}
