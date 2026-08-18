import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "migrations/0055_disable_legacy_schedules.sql";

function migrationSql(): string {
  return readFileSync(migrationPath, "utf8").replace(/\s+/gu, " ").trim();
}

describe("SPEC-DISABLE-LEGACY-SCHEDULES-001: legacy schedule quarantine", () => {
  it("disables unsupported schedules without deleting schedules or fire history", () => {
    const sql = migrationSql();

    expect(sql).toContain("UPDATE minutka_private.process_schedules");
    expect(sql).toContain("SET enabled = false");
    expect(sql).toContain("updated_at = now()");
    expect(sql).toContain("WHERE enabled");
    expect(sql).toContain("kind <> 'process'");
    expect(sql).toContain("process_id NOT IN ('morning_activity_collection', 'evening_reflection')");
    expect(sql).not.toMatch(/DELETE FROM minutka_private\.(?:process_schedules|schedule_fires)/u);
    expect(sql).not.toMatch(/UPDATE minutka_private\.schedule_fires/u);
  });
});
