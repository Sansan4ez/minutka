import { describe, expect, it } from "vitest";
import {
  loadRoutineDirectory,
  roleSection,
  roleSectionForSuggest,
  RoutineDirectoryError,
  routineDirectoryCounts,
} from "../../../src/application/routine-directory.js";

const validDirectory = {
  schemaVersion: "minutka-routine-directory/v1",
  companyId: "company_a",
  version: "2026-09-07.1",
  sections: [
    {
      roleId: "sales",
      entries: [
        {
          id: "sales_follow_up",
          name: "Контроль следующих шагов",
          description: "Проверка статуса и напоминания по открытым задачам",
          examples: ["Проверить статус договора"],
          quickWin: "waiting_sla",
          methodologistNote: "Проверять наличие даты следующего шага",
          provenance: [{ groupId: "group_a", subjectKey: "subject_1" }],
        },
        {
          id: "sales_research",
          name: "Исследование клиентов",
          description: "Поиск и отбор информации о клиентах",
          examples: ["Собрать информацию о компании"],
          quickWin: "deep_dive",
          provenance: [{ groupId: "group_a", subjectKey: "subject_2" }],
        },
      ],
    },
  ],
} as const;

describe("SPEC-MINUTKA-ROUTINE-DIRECTORY-001: validated routine directory", () => {
  it("loads a valid directory and exposes only model-safe role projections", () => {
    const directory = loadRoutineDirectory(validDirectory, { expectedCompanyId: "company_a" });
    expect(directory.companyId).toBe("company_a");
    expect(routineDirectoryCounts(directory)).toEqual({ roles: 1, entries: 2, quickWins: 1, deepDive: 1 });

    const extractorSection = roleSection(directory, "sales");
    expect(extractorSection).toEqual({
      version: "2026-09-07.1",
      entries: [
        {
          id: "sales_follow_up",
          name: "Контроль следующих шагов",
          description: "Проверка статуса и напоминания по открытым задачам",
          examples: ["Проверить статус договора"],
        },
        {
          id: "sales_research",
          name: "Исследование клиентов",
          description: "Поиск и отбор информации о клиентах",
          examples: ["Собрать информацию о компании"],
        },
      ],
    });
    expect(JSON.stringify(extractorSection)).not.toContain("provenance");
    expect(JSON.stringify(extractorSection)).not.toContain("methodologistNote");
    expect(roleSection(directory, "unknown")).toEqual({ version: "2026-09-07.1", entries: [] });

    expect(roleSectionForSuggest(directory, "sales").entries[0]).toMatchObject({ quickWin: "waiting_sla", methodologistNote: "Проверять наличие даты следующего шага" });
    expect(JSON.stringify(roleSectionForSuggest(directory, "sales"))).not.toContain("provenance");
  });

  const cases: Array<[string, unknown, string]> = [
    ["scope mismatch", { ...validDirectory, companyId: "company_b" }, "directory_scope_mismatch"],
    ["version missing", { ...validDirectory, version: "" }, "directory_version_missing"],
    ["duplicate id", { ...validDirectory, sections: [{ ...validDirectory.sections[0], entries: [validDirectory.sections[0].entries[0], { ...validDirectory.sections[0].entries[1], id: validDirectory.sections[0].entries[0].id }] }] }, "directory_duplicate_id"],
    ["unknown quick win", { ...validDirectory, sections: [{ ...validDirectory.sections[0], entries: [{ ...validDirectory.sections[0].entries[0], quickWin: "not-a-quick-win" }] }] }, "directory_unknown_quick_win"],
    ["provenance missing", { ...validDirectory, sections: [{ ...validDirectory.sections[0], entries: [{ ...validDirectory.sections[0].entries[0], provenance: [] }] }] }, "directory_provenance_missing"],
    ["schema invalid", { ...validDirectory, sections: [{ ...validDirectory.sections[0], entries: [{ ...validDirectory.sections[0].entries[0], name: "x" }] }] }, "directory_schema_invalid"],
  ];

  for (const [label, input, code] of cases) {
    it(`reports ${label} as a typed error`, () => {
      expect(() => loadRoutineDirectory(input, { expectedCompanyId: "company_a" })).toThrowError(
        expect.objectContaining({ code }),
      );
      try {
        loadRoutineDirectory(input, { expectedCompanyId: "company_a" });
      } catch (error) {
        expect(error).toBeInstanceOf(RoutineDirectoryError);
      }
    });
  }
});
