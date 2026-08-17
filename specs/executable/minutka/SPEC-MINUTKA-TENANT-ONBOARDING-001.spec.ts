import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { RoleNotInCompanyError } from "../../../src/application/onboarding-role-error.js";
import { mapError } from "../../../src/server/http/error-mapping.js";

const migrationPath = "migrations/0048_bind_invites_to_tenant.sql";
const roleUpdateMigrationPath = "migrations/0051_cascade_profile_role_updates.sql";

async function consent(runtime: ReturnType<typeof createInMemoryRuntime>, employeeId: string) {
  await runtime.service.openInvite({ inviteCode: `invite_${employeeId}` });
  await runtime.service.acceptConsent({ employeeId, accepted: true, source: "test" });
}

describe("SPEC-MINUTKA-TENANT-ONBOARDING-001: tenant invite and company role", () => {
  it("binds an invite to a company and one of its groups", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    world.tenantDirectories.roles.push({ id: "role_a", companyId: "company_a", name: "Логист" });
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });

    await runtime.service.issueInvite({
      employeeId: "employee_a",
      inviteCode: "invite_employee_a",
      companyId: "company_a",
      groupId: "group_a",
    });
    await runtime.service.openInvite({ inviteCode: "invite_employee_a" });

    expect(world.participants[0]).toMatchObject({
      employeeId: "employee_a",
      companyId: "company_a",
      groupId: "group_a",
      status: "invite_opened",
    });
  });

  it("accepts only a role id from the participant company", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    world.tenantDirectories.roles.push(
      { id: "role_a", companyId: "company_a", name: "Логист" },
      { id: "role_b", companyId: "company_b", name: "Бухгалтер" },
    );
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });
    await runtime.service.issueInvite({ employeeId: "employee_a", inviteCode: "invite_employee_a", companyId: "company_a", groupId: "group_a" });
    await consent(runtime, "employee_a");

    // The refusal is a typed contract error, so the boundary can name the reason
    // instead of reporting an unknown failure.
    for (const roleId of ["Логист", "role_b"]) {
      await expect(runtime.service.completeOnboarding({
        employeeId: "employee_a",
        roleId,
        persona: "efficiency",
      })).rejects.toThrow(RoleNotInCompanyError);
    }
    expect(mapError(new RoleNotInCompanyError())).toEqual({
      status: 400,
      code: "invalid_request",
      message: "roleId must belong to the participant company",
    });

    const completed = await runtime.service.completeOnboarding({
      employeeId: "employee_a",
      roleId: "role_a",
      persona: "efficiency",
    });
    expect(completed.profile).toMatchObject({ companyId: "company_a", groupId: "group_a", roleId: "role_a" });
  });

  it("shows role names, accepts an unambiguous name or id, and re-prompts unknown or ambiguous text", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    world.tenantDirectories.roles.push(
      { id: "role_logistician", companyId: "company_a", name: "Логист" },
      { id: "role_manager", companyId: "company_a", name: "Руководитель" },
      { id: "role_manager_duplicate", companyId: "company_a", name: "Руководитель" },
    );
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });
    await runtime.service.issueInvite({ employeeId: "employee_role_choice", inviteCode: "invite_employee_role_choice", companyId: "company_a", groupId: "group_a" });
    await consent(runtime, "employee_role_choice");

    const initial = await runtime.service.submitOnboardingAnswer({ employeeId: "employee_role_choice", text: "неизвестная должность" });
    expect(initial).toMatchObject({
      status: "needs_choice",
      field: "roleId",
      choices: ["Логист", "Руководитель", "Руководитель"],
      choiceValues: ["role_logistician", "role_manager", "role_manager_duplicate"],
      allowFreeText: true,
    });
    expect(initial).toMatchObject({ prompt: expect.stringContaining("Не нашёл такую должность") });
    expect(world.onboardingDrafts[0]).toMatchObject({ pendingField: "roleId" });
    expect(world.onboardingDrafts[0].roleId).toBeUndefined();

    await expect(runtime.service.submitOnboardingAnswer({ employeeId: "employee_role_choice", text: "Руководитель" })).resolves.toMatchObject({
      status: "needs_choice",
      field: "roleId",
      prompt: expect.stringContaining("Выберите должность из списка"),
    });
    expect(world.onboardingDrafts[0]).toMatchObject({ pendingField: "roleId" });
    expect(world.onboardingDrafts[0].roleId).toBeUndefined();

    await expect(runtime.service.submitOnboardingAnswer({ employeeId: "employee_role_choice", text: "ЛОГИСТ" })).resolves.toMatchObject({
      status: "needs_answer",
      field: "preferredName",
    });
    expect(world.onboardingDrafts[0]).toMatchObject({ roleId: "role_logistician", pendingField: "preferredName" });

    await runtime.service.issueInvite({ employeeId: "employee_role_id", inviteCode: "invite_employee_role_id", companyId: "company_a", groupId: "group_a" });
    await consent(runtime, "employee_role_id");
    await expect(runtime.service.submitOnboardingAnswer({ employeeId: "employee_role_id", text: "role_manager" })).resolves.toMatchObject({
      status: "needs_answer",
      field: "preferredName",
    });
    expect(world.onboardingDrafts).toContainEqual(expect.objectContaining({ employeeId: "employee_role_id", roleId: "role_manager" }));
  });

  it("updates a completed profile when only the company role changes", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    world.tenantDirectories.roles.push(
      { id: "role_a", companyId: "company_a", name: "Логист" },
      { id: "role_b", companyId: "company_a", name: "Руководитель логистики" },
    );
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });
    await runtime.service.issueInvite({ employeeId: "employee_role_change", inviteCode: "invite_employee_role_change", companyId: "company_a", groupId: "group_a" });
    await consent(runtime, "employee_role_change");

    await runtime.service.completeOnboarding({
      employeeId: "employee_role_change",
      roleId: "role_a",
      persona: "efficiency",
    });
    const updated = await runtime.service.completeOnboarding({
      employeeId: "employee_role_change",
      roleId: "role_b",
      persona: "efficiency",
    });

    expect(updated).toMatchObject({ completion: "new", profile: { roleId: "role_b" } });
    expect(world.profiles).toContainEqual(expect.objectContaining({ employeeId: "employee_role_change", roleId: "role_b" }));
    expect(world.participants).toContainEqual(expect.objectContaining({ employeeId: "employee_role_change", roleId: "role_b" }));
  });

  it("keeps free-text self-description personal and outside anonymized storage", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    world.tenantDirectories.roles.push({ id: "role_a", companyId: "company_a", name: "Логист" });
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });
    await runtime.service.issueInvite({ employeeId: "employee_a", inviteCode: "invite_employee_a", companyId: "company_a", groupId: "group_a" });
    await consent(runtime, "employee_a");

    await runtime.service.completeOnboarding({
      employeeId: "employee_a",
      roleId: "role_a",
      selfDescription: "Собираю заявки магазинов и разруливаю срочные доставки",
      persona: "efficiency",
    });

    expect(world.profiles[0].role).toBe("Собираю заявки магазинов и разруливаю срочные доставки");
    const anonymizedMigration = readFileSync("migrations/0047_create_activity_dual_write.sql", "utf8");
    expect(anonymizedMigration).not.toMatch(/self_description|\brole\s+text|typical_tasks/iu);
  });

  it("persists tenant and role bindings with company-scoped foreign keys", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("ADD COLUMN company_id text");
    expect(sql).toContain("ADD COLUMN group_id text");
    expect(sql).toContain("ADD COLUMN role_id text");
    expect(sql).toContain("REFERENCES minutka_reference.training_groups(company_id, id)");
    expect(sql).toContain("REFERENCES minutka_reference.roles(company_id, id)");
    const roleUpdateSql = readFileSync(roleUpdateMigrationPath, "utf8");
    expect(roleUpdateSql).toMatch(/profiles_employee_role_fk[\s\S]*ON UPDATE CASCADE/u);
    const deletionSql = readFileSync("migrations/0053_cascade_profile_participant_deletion.sql", "utf8");
    expect(deletionSql).toMatch(/DROP CONSTRAINT profiles_employee_id_fkey[\s\S]*profiles_employee_role_fk[\s\S]*ON UPDATE CASCADE[\s\S]*ON DELETE CASCADE/u);
  });
});
