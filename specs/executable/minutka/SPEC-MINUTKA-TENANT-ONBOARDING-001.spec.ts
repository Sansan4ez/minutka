import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";

const migrationPath = "migrations/0048_bind_invites_to_tenant.sql";

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

    await expect(runtime.service.completeOnboarding({
      employeeId: "employee_a",
      roleId: "Логист",
      persona: "efficiency",
    })).rejects.toThrow("roleId must belong to the participant company");
    await expect(runtime.service.completeOnboarding({
      employeeId: "employee_a",
      roleId: "role_b",
      persona: "efficiency",
    })).rejects.toThrow("roleId must belong to the participant company");

    const completed = await runtime.service.completeOnboarding({
      employeeId: "employee_a",
      roleId: "role_a",
      persona: "efficiency",
    });
    expect(completed.profile).toMatchObject({ companyId: "company_a", groupId: "group_a", roleId: "role_a" });
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
  });
});
