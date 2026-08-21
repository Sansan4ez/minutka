import { describe, expect, it } from "vitest";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { runMinutkaCli, type CliResult } from "../../../src/client/cli/minutka-cli.js";
import { AdminMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { createInProcessAdminTransport } from "../../../src/server/http/in-process-transport.js";

function adminClient(runtime: ReturnType<typeof createInMemoryRuntime>) {
  return new AdminMinutkaClient(createInProcessAdminTransport(runtime.service, { kind: "operator", operatorId: "spec" }));
}

async function adminCli(runtime: ReturnType<typeof createInMemoryRuntime>, args: string[]): Promise<CliResult> {
  return runMinutkaCli(adminClient(runtime), args);
}

describe("SPEC-MINUTKA-REVOKE-INVITE-001: revoke unused invite", () => {
  it("deletes a participant in invite_issued status", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    world.tenantDirectories.roles.push({ id: "role_a", companyId: "company_a", name: "Логист" });
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });

    await runtime.service.issueInvite({
      employeeId: "emp_typo",
      inviteCode: "invite_typo",
      companyId: "company_a",
      groupId: "group_a",
    });
    expect(world.participants).toHaveLength(1);
    expect(world.participants[0]).toMatchObject({ employeeId: "emp_typo", status: "invite_issued" });

    const result = await runtime.service.deleteInvitedParticipant({
      employeeId: "emp_typo",
      companyId: "company_a",
      groupId: "group_a",
      confirm: "DELETE emp_typo",
    });

    expect(result).toEqual({ employeeId: "emp_typo", deleted: true });
    expect(world.participants).toHaveLength(0);
  });

  it("allows re-invite after revocation", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });

    await runtime.service.issueInvite({
      employeeId: "emp_old",
      inviteCode: "invite_old",
      companyId: "company_a",
      groupId: "group_a",
    });
    await runtime.service.deleteInvitedParticipant({
      employeeId: "emp_old",
      companyId: "company_a",
      groupId: "group_a",
      confirm: "DELETE emp_old",
    });

    const reissued = await runtime.service.issueInvite({
      employeeId: "emp_old",
      inviteCode: "invite_new",
      companyId: "company_a",
      groupId: "group_a",
    });
    expect(reissued.created).toBe(true);
    expect(world.participants).toHaveLength(1);
    expect(world.participants[0]).toMatchObject({ employeeId: "emp_old", status: "invite_issued" });
  });

  it("rejects deletion for participant beyond invite_issued status", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });

    await runtime.service.issueInvite({
      employeeId: "emp_active",
      inviteCode: "invite_active",
      companyId: "company_a",
      groupId: "group_a",
    });
    await runtime.service.openInvite({ inviteCode: "invite_active" });

    await expect(runtime.service.deleteInvitedParticipant({
      employeeId: "emp_active",
      companyId: "company_a",
      groupId: "group_a",
      confirm: "DELETE emp_active",
    })).rejects.toThrow(/employee:data:delete/);

    // Participant is untouched
    expect(world.participants).toHaveLength(1);
    expect(world.participants[0]).toMatchObject({ status: "invite_opened" });
  });

  it("rejects deletion without matching confirmation string", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });

    await runtime.service.issueInvite({
      employeeId: "emp_x",
      inviteCode: "invite_x",
      companyId: "company_a",
      groupId: "group_a",
    });

    await expect(runtime.service.deleteInvitedParticipant({
      employeeId: "emp_x",
      companyId: "company_a",
      groupId: "group_a",
      confirm: "WRONG",
    })).rejects.toThrow(/confirmation/);

    expect(world.participants).toHaveLength(1);
  });

  it("enforces tenant isolation: different company/group scope is rejected", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push(
      { id: "group_a", companyId: "company_a" },
      { id: "group_b", companyId: "company_b" },
    );
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });

    await runtime.service.issueInvite({
      employeeId: "emp_isolated",
      inviteCode: "invite_isolated",
      companyId: "company_a",
      groupId: "group_a",
    });

    // Attempt to delete with wrong company scope
    await expect(runtime.service.deleteInvitedParticipant({
      employeeId: "emp_isolated",
      companyId: "company_b",
      groupId: "group_b",
      confirm: "DELETE emp_isolated",
    })).rejects.toThrow(/tenant/i);

    // Participant is still present
    expect(world.participants).toHaveLength(1);
  });

  it("records an audit event with employeeId and scope", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });

    await runtime.service.issueInvite({
      employeeId: "emp_audit",
      inviteCode: "invite_audit",
      companyId: "company_a",
      groupId: "group_a",
    });
    await runtime.service.deleteInvitedParticipant({
      employeeId: "emp_audit",
      companyId: "company_a",
      groupId: "group_a",
      confirm: "DELETE emp_audit",
    });

    const revokedEvents = world.auditEvents.filter((e) => e.type === "invite_revoked");
    expect(revokedEvents).toHaveLength(1);
    expect(revokedEvents[0]).toMatchObject({
      type: "invite_revoked",
      employeeId: "emp_audit",
      metadata: { companyId: "company_a", groupId: "group_a" },
    });
  });

  it("CLI revoke-invite command works with confirmation", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });

    await runtime.service.issueInvite({
      employeeId: "emp_cli",
      inviteCode: "invite_cli",
      companyId: "company_a",
      groupId: "group_a",
    });

    const result = await adminCli(runtime, [
      "admin", "revoke-invite",
      "--employee", "emp_cli",
      "--company", "company_a",
      "--group", "group_a",
      "--confirm", "DELETE emp_cli",
    ]);

    expect(result.exitCode).toBe(0);
    expect(world.participants).toHaveLength(0);
    const parsed = JSON.parse(result.stdout[0]!);
    expect(parsed).toEqual({ employeeId: "emp_cli", deleted: true });
  });

  it("CLI revoke-invite rejects wrong confirmation", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });

    await runtime.service.issueInvite({
      employeeId: "emp_wrong",
      inviteCode: "invite_wrong",
      companyId: "company_a",
      groupId: "group_a",
    });

    const result = await adminCli(runtime, [
      "admin", "revoke-invite",
      "--employee", "emp_wrong",
      "--company", "company_a",
      "--group", "group_a",
      "--confirm", "NOPE",
    ]);

    expect(result.exitCode).toBe(1);
    expect(world.participants).toHaveLength(1);
  });

  it("CLI admin invite hint references revoke-invite", async () => {
    const world = createInMemoryWorld();
    world.tenantDirectories.groups.push({ id: "group_a", companyId: "company_a" });
    const runtime = createInMemoryRuntime({ world, agentRunner: async () => "ok" });

    // First invite succeeds
    await runtime.service.issueInvite({
      employeeId: "emp_dup",
      inviteCode: "invite_dup",
      companyId: "company_a",
      groupId: "group_a",
    });

    // Second invite via CLI fails with hint
    const result = await adminCli(runtime, [
      "admin", "invite",
      "--employee", "emp_dup",
      "--company", "company_a",
      "--group", "group_a",
      "--bot", "TestBot12345",
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.join(" ")).toMatch(/revoke-invite/);
  });
});
