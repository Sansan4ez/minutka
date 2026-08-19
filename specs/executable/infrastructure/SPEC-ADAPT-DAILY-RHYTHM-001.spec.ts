import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "migrations/0067_adapt_daily_rhythm.sql";

describe("SPEC-ADAPT-DAILY-RHYTHM-001: morning schedule migration", () => {
  it("rebinds the process in place without changing personal schedule settings or fire history", () => {
    const sql = readFileSync(migrationPath, "utf8").replace(/\s+/gu, " ").trim();

    expect(sql).toContain("UPDATE minutka_private.process_schedules");
    expect(sql).toContain("SET process_id = 'morning_planning'");
    expect(sql).toContain("process_id = 'morning_activity_collection'");
    expect(sql).not.toMatch(/SET[^;]*(?:time_of_day|timezone|enabled|days_of_week|next_fire_at)\s*=/u);
    expect(sql).not.toMatch(/DELETE FROM minutka_private\.(?:process_schedules|schedule_fires)/u);
    expect(sql).not.toMatch(/UPDATE minutka_private\.schedule_fires/u);
  });
});
