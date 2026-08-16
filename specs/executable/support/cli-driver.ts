import { AdminMinutkaClient, EmployeeMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { runMinutkaCli, type CliResult } from "../../../src/client/cli/minutka-cli.js";
import type { InMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInProcessAdminTransport, createInProcessEmployeeTransport } from "../../../src/server/http/in-process-transport.js";
import type { AgentRunner, MinutkaServiceDeps } from "../../../src/application/minutka-service.js";
import { testTenant } from "./fixtures.js";

/** Legacy spec adapter. New HTTP/CLI specs exercise the public grammar directly. */
export class CliDriver {
  private readonly runtime;
  constructor(world: InMemoryWorld, agentRunner: AgentRunner, private readonly onCommand?: (commandPath: string) => void, deps: MinutkaServiceDeps = {}) { this.runtime = createInMemoryRuntime({ world, agentRunner, deps }); }
  async run(args: string[]): Promise<CliResult> {
    const commandPath: string[] = []; for (const token of args) { if (token.startsWith("-")) break; commandPath.push(token); } this.onCommand?.(commandPath.join(" "));
    const employeeIndex = args.indexOf("--employee"); const employeeId = employeeIndex >= 0 ? args[employeeIndex + 1] : "emp_test_1";
    if (!employeeId) return { exitCode: 1, stdout: [], stderr: ["--employee requires an employee ID"] };
    let normalized = employeeIndex >= 0 ? [...args.slice(0, employeeIndex), ...args.slice(employeeIndex + 2)] : [...args];
    if (normalized[0] === "employee" && normalized[1] === "complete-onboarding") {
      const legacyRoleIndex = normalized.indexOf("--role");
      const legacyRole = legacyRoleIndex >= 0 ? normalized[legacyRoleIndex + 1] : undefined;
      if (legacyRoleIndex >= 0) {
        normalized = normalized.filter((_, index) => index !== legacyRoleIndex && index !== legacyRoleIndex + 1);
      }
      for (const legacyOption of ["--task", "--ai-level"]) {
        while (normalized.includes(legacyOption)) {
          const optionIndex = normalized.indexOf(legacyOption);
          normalized.splice(optionIndex, 2);
        }
      }
      if (!normalized.includes("--role-id")) normalized.splice(2, 0, "--role-id", testTenant.roleId);
      if (legacyRole && !normalized.includes("--self-description")) normalized.splice(4, 0, "--self-description", legacyRole);
    }
    if (normalized[0] === "employee" && normalized[1] === "issue-invite") {
      normalized[0] = "admin"; normalized.splice(2, 0, "--employee", employeeId, "--company", testTenant.companyId, "--group", testTenant.groupId);
      return runMinutkaCli(new AdminMinutkaClient(createInProcessAdminTransport(this.runtime.service, { kind: "operator", operatorId: "spec" })), normalized);
    }
    if (normalized[0] === "employee" && normalized[1] === "open-invite" && employeeIndex >= 0) {
      const inviteIndex = normalized.indexOf("--invite"); const inviteCode = inviteIndex >= 0 ? normalized[inviteIndex + 1] : undefined;
      if (!inviteCode) return { exitCode: 1, stdout: [], stderr: ["--invite requires an invite code"] };
      await this.runtime.service.issueInvite({ employeeId, inviteCode, companyId: testTenant.companyId, groupId: testTenant.groupId });
    }
    return runMinutkaCli(new EmployeeMinutkaClient(createInProcessEmployeeTransport(this.runtime.service, { kind: "employee", employeeId })), normalized);
  }
  async json<T>(args: string[]): Promise<T> { const result = await this.run(args); if (result.exitCode !== 0) throw new Error(result.stderr.join("\n")); const lastLine = result.stdout.at(-1); if (!lastLine) throw new Error(`CLI produced no JSON for ${args.join(" ")}`); return JSON.parse(lastLine) as T; }
}
