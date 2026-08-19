import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { activitySystems } from "../../../src/domain/insights.js";

const constraintName = "activities_system_check";

function latestActivitySystemConstraintMigration(): { path: string; sql: string } {
  const path = readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .reverse()
    .map((name) => `migrations/${name}`)
    .find((candidate) => readFileSync(candidate, "utf8").includes(`ADD CONSTRAINT ${constraintName}`));
  if (!path) throw new Error(`${constraintName} migration not found`);
  return { path, sql: readFileSync(path, "utf8") };
}

function constrainedSystems(sql: string): string[] {
  const check = sql.match(/ADD CONSTRAINT activities_system_check CHECK\s*\(\s*system\s+IN\s*\(([^;]+?)\)\s*\)/is)?.[1];
  if (!check) throw new Error(`${constraintName} CHECK list not found`);
  return [...check.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

describe("ACTIVITY-SYSTEM-DICTIONARY-PARITY: the closed system dictionary matches the current database constraint", () => {
  it("keeps activitySystems and the latest CHECK migration equal in both directions", () => {
    // A value added to the dictionary but not to the CHECK is accepted by the
    // tool schema and rejected by the write, which loses a daily touch at the
    // last step. Both directions therefore ship together.
    const migration = latestActivitySystemConstraintMigration();
    const constrained = constrainedSystems(migration.sql);

    expect(new Set(constrained).size, `${migration.path} contains duplicate system values`).toBe(constrained.length);
    expect([...constrained].sort()).toEqual([...activitySystems].sort());
  });
});
