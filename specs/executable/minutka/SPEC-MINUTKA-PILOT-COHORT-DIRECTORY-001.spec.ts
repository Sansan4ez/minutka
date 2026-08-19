import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { collectActivityInputSchema } from "../../../src/contracts/minutka-activity.js";
import { tenantDirectorySeedInputSchema } from "../../../src/runtime/seed-tenant-reference-directories.js";

const examples = "docs/runbooks/examples";
const identifier = /^(?:company|group|role|emp)_[a-z0-9_]+$/u;

type Kit = ReturnType<typeof tenantDirectorySeedInputSchema.parse>;
type Binding = { employeeId: string; companyId: string; groupId: string; plannedRoleId: string };

function kit(file: string): Kit {
  return tenantDirectorySeedInputSchema.parse(JSON.parse(readFileSync(`${examples}/${file}`, "utf8")));
}

const greenLine = kit("tenant-seed-green-line.template.json");
const institute = kit("tenant-seed-algoritm-institute.template.json");
const bindings = (JSON.parse(readFileSync(`${examples}/pilot-participant-bindings.template.json`, "utf8")) as {
  bindings: Binding[];
}).bindings;

/**
 * One representative account per role of the first cohort, written the way the
 * agent must call `collectActivity`: closed values only, one obstacle, and a
 * system the operator's generic mapping already covers.
 */
const dryRuns: Record<string, unknown> = {
  role_green_line_tender_specialist: { taskCategory: "admin", routinePattern: "manual_reporting", durationBucket: "2_4h", system: "tender_platform" },
  role_green_line_logistician: { taskCategory: "coordination", routinePattern: "coordination_overhead", durationBucket: "1_2h", system: "logistics_system" },
  role_green_line_sales_manager: { taskCategory: "communication", automationCandidate: "data_entry_reduction", durationBucket: "30_60m", system: "crm" },
  role_green_line_telemarketing_manager: { taskCategory: "communication", routinePattern: "context_switching", durationBucket: "1_2h", system: "telephony" },
  role_green_line_accountant: { taskCategory: "reporting", automationCandidate: "report_generation", durationBucket: "2_4h", system: "one_c" },
  role_green_line_deputy_director: { taskCategory: "coordination", routinePattern: "meeting_overload", durationBucket: "1_2h", system: "messengers" },
  role_green_line_director: { taskCategory: "planning", routinePattern: "waiting_for_input", durationBucket: "30_60m", system: "email" },
  role_algoritm_institute_methodologist: { taskCategory: "planning", automationCandidate: "template_or_checklist", durationBucket: "1_2h", system: "spreadsheets" },
  role_algoritm_institute_teacher: { taskCategory: "meetings", routinePattern: "manual_reporting", durationBucket: "2_4h", system: "learning_platform" },
};

describe("SPEC-MINUTKA-PILOT-COHORT-DIRECTORY-001: narrow roles and a covered system dictionary for the first cohort", () => {
  it("seeds one exact role per job title, without personal or broad roles", () => {
    for (const cohort of [greenLine, institute]) {
      const ids = cohort.roles.map((role) => role.id);
      const names = cohort.roles.map((role) => role.name);

      expect(new Set(ids).size).toBe(ids.length);
      expect(new Set(names).size).toBe(names.length);
      for (const role of cohort.roles) {
        expect(role.id, "role ids stay opaque ASCII slugs and never carry a person").toMatch(identifier);
        expect(role.id.startsWith(`role_${cohort.company.id.replace(/^company_/u, "")}_`)).toBe(true);
        expect(role.name.trim().toLowerCase(), "a bare «менеджер» would merge unrelated processes").not.toBe("менеджер");
      }
      expect(cohort.company.id).toMatch(identifier);
      expect(cohort.group.id).toMatch(identifier);
    }

    expect(greenLine.roles).toHaveLength(7);
    expect(institute.roles).toHaveLength(2);
  });

  it("binds every participant to a seeded role and shares one role id across equal titles", () => {
    const rolesByCompany = new Map([greenLine, institute].map((cohort) => [
      cohort.company.id,
      new Set(cohort.roles.map((role) => role.id)),
    ]));
    const groupsByCompany = new Map([greenLine, institute].map((cohort) => [cohort.company.id, cohort.group.id]));

    expect(bindings).toHaveLength(12);
    expect(bindings.filter((binding) => binding.companyId === greenLine.company.id)).toHaveLength(9);
    expect(bindings.filter((binding) => binding.companyId === institute.company.id)).toHaveLength(3);
    expect(new Set(bindings.map((binding) => binding.employeeId)).size).toBe(bindings.length);

    for (const binding of bindings) {
      expect(binding.employeeId, "employee ids are ordinals; the person mapping stays outside the repository")
        .toMatch(identifier);
      expect(groupsByCompany.get(binding.companyId)).toBe(binding.groupId);
      expect(rolesByCompany.get(binding.companyId)?.has(binding.plannedRoleId)).toBe(true);
    }

    // Two логиста and two менеджера отдела продаж select the same narrow role id.
    const perRole = new Map<string, number>();
    for (const binding of bindings) perRole.set(binding.plannedRoleId, (perRole.get(binding.plannedRoleId) ?? 0) + 1);
    expect(perRole.get("role_green_line_logistician")).toBe(2);
    expect(perRole.get("role_green_line_sales_manager")).toBe(2);
    expect(perRole.get("role_algoritm_institute_teacher")).toBe(2);
    expect([...rolesByCompany.values()].flatMap((ids) => [...ids]).every((id) => perRole.has(id)))
      .toBe(true);
  });

  it("records a meaningful structured activity for every role without free text and without a forced «other»", () => {
    const seededRoles = [...greenLine.roles, ...institute.roles].map((role) => role.id);
    expect(Object.keys(dryRuns).sort()).toEqual([...seededRoles].sort());

    for (const [roleId, sample] of Object.entries(dryRuns)) {
      const parsed = collectActivityInputSchema.parse(sample);
      const obstacles = ["routinePattern", "automationCandidate", "energyStressMarker"]
        .filter((field) => field in parsed);

      expect(parsed, `${roleId} loses no closed value on the way through the contract`).toEqual(sample);
      expect(obstacles, `${roleId} sends exactly one obstacle`).toHaveLength(1);
      expect(parsed.taskCategory, `${roleId} names its process`).toBeDefined();
      expect(parsed.taskCategory).not.toBe("unknown");
      expect(parsed.system, `${roleId} works in a system the mapping already covers`).toBeDefined();
      expect(parsed.system).not.toBe("other");
      expect(parsed.durationBucket).toBeDefined();
    }
  });

  it("needs every generic system value added for this cohort", () => {
    const used = new Set(Object.values(dryRuns).map((sample) => (sample as { system: string }).system));

    for (const added of ["telephony", "tender_platform", "logistics_system", "learning_platform"]) {
      expect(used.has(added), `${added} was added because a cohort role has no other honest value`).toBe(true);
    }
  });
});
