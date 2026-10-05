import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { runArmFinalReportsCommand, type ArmFinalReportsCommandDeps } from "../../../src/runtime/arm-final-reports-command.js";

const args = ["--company", "c", "--group", "g"];
function harness(confirmation = "SEND FINAL REPORT c/g") {
  const preview = { companyId: "c", groupId: "g", timeOfDay: "17:00", eligible: 1, notOnboarded: 0, confirmation: "SEND FINAL REPORT c/g" };
  const deps: ArmFinalReportsCommandDeps = {
    service: { preview: vi.fn(async () => preview), arm: vi.fn(async () => ({ companyId: "c", groupId: "g", timeOfDay: "17:00", armed: 1, failed: 0, outcomes: [] })) },
    prepare: vi.fn(async () => {}), close: vi.fn(async () => {}),
    readConfirmation: vi.fn(async () => confirmation), write: vi.fn(),
  };
  return { deps, factory: vi.fn(() => deps), preview };
}

describe("Final report CLI lazy lifecycle", () => {
  it("SPEC-FINAL-REPORT-CLI-HELP-01: help needs no dependencies or DB env", async () => {
    const { factory } = harness();
    await runArmFinalReportsCommand(["--help"], factory);
    expect(factory).not.toHaveBeenCalled();
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (/DATABASE|POSTGRES|^PG|INVITE_CODE_PEPPER/.test(key)) delete env[key];
    const result = spawnSync("npm", ["run", "cycle:final-reports", "--", "--help"], { env, encoding: "utf8", timeout: 15000 });
    expect(result.status).toBe(0);
    for (const flag of ["--company", "--group", "--at", "--preview"]) expect(result.stdout).toContain(flag);
    expect(result.stderr).toBe("");
    const invalid = spawnSync("npm", ["run", "cycle:final-reports", "--", "--company", "c"], { env, encoding: "utf8", timeout: 15000 });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("required option '--group <groupId>' not specified");
    expect(invalid.stderr).not.toMatch(/migration|database|\n\s+at /i);
  });

  it.each([["--company", "c"], [...args, "--unknown"]])("SPEC-FINAL-REPORT-CLI-HELP-02: invalid arguments do not initialize resources (%j)", async (...argv) => {
    const { factory } = harness();
    await expect(runArmFinalReportsCommand(argv, factory)).rejects.toMatchObject({ exitCode: 1 });
    expect(factory).not.toHaveBeenCalled();
  });

  it("SPEC-FINAL-REPORT-CLI-HELP-03: pending migrations reject preview and close resources", async () => {
    const { deps, factory } = harness();
    deps.prepare = vi.fn(async () => { throw new Error("database migrations are pending: 0085; run npm run db:migrate"); });
    await expect(runArmFinalReportsCommand([...args, "--preview"], factory)).rejects.toThrow("migrations are pending");
    expect(deps.service.preview).not.toHaveBeenCalled();
    expect(deps.service.arm).not.toHaveBeenCalled();
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it("SPEC-FINAL-REPORT-CLI-HELP-04: ready preview is read-only and closes resources", async () => {
    const { deps, factory, preview } = harness();
    await runArmFinalReportsCommand([...args, "--preview"], factory);
    expect(deps.write).toHaveBeenCalledWith(`${JSON.stringify(preview, null, 2)}\n`);
    expect(deps.service.arm).not.toHaveBeenCalled();
    expect(deps.readConfirmation).not.toHaveBeenCalled();
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it("action failure still closes resources", async () => {
    const { deps, factory } = harness();
    deps.service.arm = vi.fn(async () => { throw new Error("arming failed"); });
    await expect(runArmFinalReportsCommand(args, factory)).rejects.toThrow("arming failed");
    expect(deps.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])("SPEC-FINAL-REPORT-CLI-HELP-05: exact confirmation required; cleanup always (exact=%s)", async (exact) => {
    const { deps, factory } = harness(exact ? "SEND FINAL REPORT c/g" : "yes");
    const action = runArmFinalReportsCommand(args, factory);
    if (exact) await action;
    else await expect(action).rejects.toThrow("confirmation did not match");
    expect(deps.service.arm).toHaveBeenCalledTimes(exact ? 1 : 0);
    expect(deps.close).toHaveBeenCalledOnce();
  });
});
