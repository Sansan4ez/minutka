import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { auditEventTypes } from "../../../src/application/audit-event-store.js";

const constraintName = "audit_events_event_type_check";

function latestAuditEventConstraintMigration(): { path: string; sql: string } {
  const path = readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .reverse()
    .map((name) => `migrations/${name}`)
    .find((candidate) => readFileSync(candidate, "utf8").includes(constraintName));
  if (!path) throw new Error(`${constraintName} migration not found`);
  return { path, sql: readFileSync(path, "utf8") };
}

function constrainedAuditEventTypes(sql: string): string[] {
  const check = sql.match(/CHECK\s*\(\s*event_type\s+IN\s*\(([^;]+?)\)\s*\)/is)?.[1];
  if (!check) throw new Error(`${constraintName} CHECK list not found`);
  return [...check.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

describe("AUDIT-EVENT-TYPE-PARITY: runtime event types match the current database constraint", () => {
  it("keeps AuditEventType and the latest CHECK migration equal in both directions", () => {
    const migration = latestAuditEventConstraintMigration();
    const constrainedTypes = constrainedAuditEventTypes(migration.sql);

    expect(new Set(constrainedTypes).size, `${migration.path} contains duplicate event types`).toBe(constrainedTypes.length);
    expect([...constrainedTypes].sort()).toEqual([...auditEventTypes].sort());
  });
});
