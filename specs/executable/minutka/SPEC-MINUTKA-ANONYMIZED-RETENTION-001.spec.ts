import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CompanyAnonymizedActivityRetentionService } from "../../../src/application/company-anonymized-activity-retention.js";
import {
  createInMemoryActivityCollectionState,
  createInMemoryActivityCollectionStore,
} from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";

const activity = (companyId: string, groupId: string, roleId: string) => ({
  companyId,
  groupId,
  roleId,
  kind: "task_category" as const,
  value: "reporting" as const,
  date: "2026-08-15",
});

describe("SPEC-MINUTKA-ANONYMIZED-RETENTION-001: company-scoped retention", () => {
  it("deletes only the selected company's anonymized slice", async () => {
    const state = createInMemoryActivityCollectionState();
    state.anonymizedActivities.push(
      activity("company_a", "group_a", "role_a"),
      activity("company_a", "group_a", "role_a"),
      activity("company_b", "group_b", "role_b"),
    );
    const service = new CompanyAnonymizedActivityRetentionService(
      createInMemoryActivityCollectionStore(state),
    );

    await expect(service.purgeCompany({ companyId: " company_a " })).resolves.toEqual({
      companyId: "company_a",
      deletedRows: 2,
    });
    expect(state.anonymizedActivities).toEqual([
      activity("company_b", "group_b", "role_b"),
    ]);
  });

  it("does not remove anonymized rows when an employee deletes personal data", async () => {
    const world = createInMemoryWorld();
    const profiles = createInMemoryProfileStore(world);
    await profiles.issueInvite({
      employeeId: "employee_a",
      inviteCode: "invite_a",
      companyId: "company_a",
      groupId: "group_a",
      issuedAt: "2026-08-15T00:00:00.000Z",
    });
    const state = createInMemoryActivityCollectionState();
    state.anonymizedActivities.push(activity("company_a", "group_a", "role_a"));

    await profiles.deleteEmployeePersonalData("employee_a");

    expect(world.participants).toEqual([]);
    expect(state.anonymizedActivities).toEqual([
      activity("company_a", "group_a", "role_a"),
    ]);
  });

  it("exposes one documented company_id command for pilot completion and emergency reset", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const runbook = readFileSync("docs/runbooks/company-anonymized-data-retention.md", "utf8");
    const postgresStore = readFileSync(
      "src/infrastructure/postgres/postgres-company-anonymized-activity-retention-store.ts",
      "utf8",
    );
    const grantMigration = readFileSync("migrations/0050_grant_reporting_retention.sql", "utf8");

    expect(packageJson.scripts["company:anonymized:purge"]).toBe(
      "tsx src/runtime/purge-company-anonymized-activities.ts",
    );
    expect(postgresStore).toContain(
      "DELETE FROM minutka_reporting.anonymized_activities WHERE company_id = $1",
    );
    expect(grantMigration).toContain(
      "GRANT DELETE ON minutka_reporting.anonymized_activities TO minutka_runtime",
    );
    expect(runbook).toContain("npm run company:anonymized:purge -- <company_id>");
    expect(runbook).toContain("Завершение пилота");
    expect(runbook).toContain("Аварийный сброс");
    expect(runbook).toContain("backfill");
  });
});
