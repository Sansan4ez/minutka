import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CompanyAnonymizedActivityRetentionMismatchError,
  CompanyAnonymizedActivityRetentionService,
} from "../../../src/application/company-anonymized-activity-retention.js";
import {
  createInMemoryActivityCollectionState,
  createInMemoryActivityCollectionStore,
} from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { runCompanyAnonymizedPurgeCommand } from "../../../src/runtime/company-anonymized-purge-command.js";

const activity = (companyId: string, groupId: string, roleId: string) => ({
  companyId,
  groupId,
  roleId,
  kind: "task_category" as const,
  value: "reporting" as const,
  date: "2026-08-15",
});

function commandHarness(input: {
  companyId?: string;
  rows?: ReturnType<typeof activity>[];
  interactiveTerminal?: boolean;
  confirmation?: string | Error;
}) {
  const state = createInMemoryActivityCollectionState();
  state.anonymizedActivities.push(...(input.rows ?? []));
  const retention = new CompanyAnonymizedActivityRetentionService(
    createInMemoryActivityCollectionStore(state),
  );
  let output = "";
  return {
    state,
    retention,
    output: () => output,
    run: () => runCompanyAnonymizedPurgeCommand({
      companyId: input.companyId ?? "company_a",
      retention,
      interactiveTerminal: input.interactiveTerminal ?? true,
      readConfirmation: async () => {
        if (input.confirmation instanceof Error) throw input.confirmation;
        return input.confirmation ?? "";
      },
      write: (text) => { output += text; },
    }),
  };
}

describe("SPEC-MINUTKA-ANONYMIZED-RETENTION-001: confirmed company-scoped retention", () => {
  it("previews the slice and refuses missing, mismatched, EOF, and non-TTY confirmations", async () => {
    for (const confirmation of ["", "PURGE company_b 2", "PURGE company_a 1"]) {
      const harness = commandHarness({
        rows: [activity("company_a", "group_a", "role_a"), activity("company_a", "group_a", "role_a")],
        confirmation,
      });
      await expect(harness.run()).rejects.toThrow("confirmation did not match; nothing was deleted");
      expect(harness.state.anonymizedActivities).toHaveLength(2);
      expect(harness.output()).toContain("companyId=company_a, expectedRows=2");
    }

    const eof = commandHarness({ rows: [activity("company_a", "group_a", "role_a")], confirmation: new Error("EOF") });
    await expect(eof.run()).rejects.toThrow("confirmation was not received; nothing was deleted");
    expect(eof.state.anonymizedActivities).toHaveLength(1);

    const piped = commandHarness({
      rows: [activity("company_a", "group_a", "role_a")],
      interactiveTerminal: false,
      confirmation: "PURGE company_a 1",
    });
    await expect(piped.run()).rejects.toThrow("interactive TTY confirmation is required; nothing was deleted");
    expect(piped.state.anonymizedActivities).toHaveLength(1);
  });

  it("deletes only the confirmed company's anonymized slice and prints the bounded result", async () => {
    const harness = commandHarness({
      rows: [
        activity("company_a", "group_a", "role_a"),
        activity("company_a", "group_a", "role_a"),
        activity("company_b", "group_b", "role_b"),
      ],
      confirmation: "PURGE company_a 2",
    });

    await expect(harness.run()).resolves.toEqual({ companyId: "company_a", expectedRows: 2, deletedRows: 2 });
    expect(harness.state.anonymizedActivities).toEqual([activity("company_b", "group_b", "role_b")]);
    expect(harness.output()).toContain("irreversible level-2 operation");
    expect(harness.output()).toContain("There is no backfill");
    expect(harness.output()).toContain('{"companyId":"company_a","expectedRows":2,"deletedRows":2}');
  });

  it("returns a safe zero-row no-op without asking for confirmation", async () => {
    const harness = commandHarness({ interactiveTerminal: false, confirmation: new Error("must not read") });
    await expect(harness.run()).resolves.toEqual({ companyId: "company_a", expectedRows: 0, deletedRows: 0 });
    expect(harness.output()).toContain("No anonymized rows found; nothing was deleted.");
  });

  it("rejects a stale preview without partially deleting the company slice", async () => {
    const harness = commandHarness({ rows: [activity("company_a", "group_a", "role_a")] });
    const preview = await harness.retention.previewCompany({ companyId: " company_a " });
    harness.state.anonymizedActivities.push(activity("company_a", "group_a", "role_a"));

    await expect(harness.retention.purgeCompany(preview)).rejects.toEqual(
      new CompanyAnonymizedActivityRetentionMismatchError("company_a", 1, 2),
    );
    expect(harness.state.anonymizedActivities).toHaveLength(2);
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
    expect(state.anonymizedActivities).toEqual([activity("company_a", "group_a", "role_a")]);
  });

  it("documents the level-2 operator challenge, retry, no-op, and isolation boundaries", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    const runbook = readFileSync("docs/runbooks/company-anonymized-data-retention.md", "utf8");
    const pilotRun = readFileSync("docs/runbooks/minutka-pilot-run.md", "utf8");
    const rfc = readFileSync("docs/architecture/rfc-personal-assistant-architecture.md", "utf8");
    const runtime = readFileSync("src/runtime/purge-company-anonymized-activities.ts", "utf8");
    const grantMigration = readFileSync("migrations/0050_grant_reporting_retention.sql", "utf8");

    expect(packageJson.scripts["company:anonymized:purge"]).toBe("tsx src/runtime/purge-company-anonymized-activities.ts");
    expect(runtime).toContain("stdin.isTTY && stdout.isTTY");
    expect(grantMigration).toContain("GRANT DELETE ON minutka_reporting.anonymized_activities TO minutka_runtime");
    for (const document of [runbook, pilotRun]) {
      expect(document).toContain("PURGE <company_id> <expectedRows>");
      expect(document).toContain("TTY");
      expect(document).toContain("expectedRows");
    }
    expect(runbook).toContain("mismatch");
    expect(runbook).toContain("no-op");
    expect(runbook).toContain("backfill");
    expect(rfc).toContain("интерактивный TTY challenge");
    expect(rfc).toContain("employee-facing");
  });
});
