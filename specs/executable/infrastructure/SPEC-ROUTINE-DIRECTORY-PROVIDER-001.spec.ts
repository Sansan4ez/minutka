import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { routineDirectorySectionBudget } from "../../../src/application/routine-directory.js";
import {
  loadRoutineDirectoryProviderFromDirectory,
} from "../../../src/infrastructure/routine-directory-provider.js";

const directory = {
  schemaVersion: "minutka-routine-directory/v1",
  companyId: "company_a",
  version: "1",
  sections: [{
    roleId: "role_a",
    entries: [{
      id: "routine_a",
      name: "Prepare reports",
      description: "Prepare reports",
      examples: ["prepared a report"],
      workCategory: "documents_contracts",
      quickWin: "deep_dive",
      provenance: [{ groupId: "group_a", subjectKey: "subject_a" }],
    }],
  }],
} as const;

function withDirectory(run: (path: string) => void): void {
  const path = mkdtempSync(join(process.cwd(), "tmp-routine-directory-"));
  try { run(path); } finally { rmSync(path, { recursive: true, force: true }); }
}

describe("SPEC-ROUTINE-DIRECTORY-PROVIDER-001: startup routine directory provider", () => {
  it("loads role sections once and returns undefined for an absent company or role", () => {
    withDirectory((path) => {
      writeFileSync(join(path, "routine-directory.company_a.json"), JSON.stringify(directory));
      const warnings: string[] = [];
      const provider = loadRoutineDirectoryProviderFromDirectory(path, { warn: (message) => warnings.push(message) });

      expect(provider("company_a", "role_a")).toEqual({
        version: "1",
        entries: [{ id: "routine_a", name: "Prepare reports", description: "Prepare reports", examples: ["prepared a report"] }],
      });
      expect(provider("company_a", "role_other")).toBeUndefined();
      expect(provider("company_b", "role_a")).toBeUndefined();
      expect(provider("company_b", "role_a")).toBeUndefined();
      expect(warnings).toEqual([
        "routine directory loaded: \"company_a\", version \"1\", entries 1, disabled sections 0",
        "Routine directory file is unavailable for company \"company_b\".",
      ]);
      expect(warnings[0]).not.toMatch(/routine_a|Prepare reports/u);
    });
  });

  it("disables only over-budget role sections and logs content-free startup counters once", () => {
    withDirectory((path) => {
      const overBudgetEntries = Array.from({ length: routineDirectorySectionBudget.maximumEntries + 1 }, (_, index) => ({
        ...directory.sections[0].entries[0],
        id: `secret_routine_${index}`,
        name: `Secret routine ${index}`,
      }));
      writeFileSync(join(path, "routine-directory.company_a.json"), JSON.stringify({
        ...directory,
        sections: [
          { roleId: "role_over_budget", entries: overBudgetEntries },
          { roleId: "role_a", entries: directory.sections[0].entries },
        ],
      }));
      const warnings: string[] = [];
      const provider = loadRoutineDirectoryProviderFromDirectory(path, { warn: (message) => warnings.push(message) });

      expect(provider("company_a", "role_over_budget")).toBeUndefined();
      expect(provider("company_a", "role_a")).toMatchObject({ version: "1", entries: [{ id: "routine_a" }] });
      expect(warnings).toEqual([
        expect.stringMatching(/^routine directory section over budget: company "company_a", role "role_over_budget", entries 41, characters \d+; section disabled$/u),
        "routine directory loaded: \"company_a\", version \"1\", entries 42, disabled sections 1",
      ]);
      expect(warnings.join("\n")).not.toMatch(/secret_routine|Secret routine|Prepare reports/u);
    });
  });

  it("does not fall back to a versioned copy when the active file is absent", () => {
    withDirectory((path) => {
      writeFileSync(join(path, "routine-directory.company_a.10.json"), JSON.stringify(directory));
      const warnings: string[] = [];
      const provider = loadRoutineDirectoryProviderFromDirectory(path, { warn: (message) => warnings.push(message) });
      expect(provider("company_a", "role_a")).toBeUndefined();
      expect(warnings).toContain("Routine directory file is unavailable for company \"company_a\".");
    });
  });

  it("fails startup with the loader's typed reason for an invalid file", () => {
    withDirectory((path) => {
      writeFileSync(join(path, "routine-directory.company_a.json"), JSON.stringify({ ...directory, companyId: "company_b" }));
      expect(() => loadRoutineDirectoryProviderFromDirectory(path)).toThrowError(
        expect.objectContaining({
          name: "RoutineDirectoryProviderStartupError",
          code: "directory_scope_mismatch",
          companyId: "company_a",
        }),
      );
    });
  });

  it("operates without sections when the configured directory is absent", () => {
    const warnings: string[] = [];
    const provider = loadRoutineDirectoryProviderFromDirectory(join(process.cwd(), "missing-routine-directory"), { warn: (message) => warnings.push(message) });
    expect(provider("company_a", "role_a")).toBeUndefined();
    expect(warnings).toEqual(["Routine directory directory is unavailable."]);
  });

  it("does not require a configured directory", () => {
    expect(loadRoutineDirectoryProviderFromDirectory(undefined)("company_a", "role_a")).toBeUndefined();
  });
});
