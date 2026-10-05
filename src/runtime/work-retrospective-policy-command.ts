import { Command, CommanderError } from "commander";
import { retrospectiveEnableSchema, type WorkRetrospectivePolicyManagement, type PolicyMutation } from "../application/work-retrospective-policy-management.js";
export type PolicyCommandDeps = { service: WorkRetrospectivePolicyManagement; write(text: string): void; readConfirmation(): Promise<string>; close(): Promise<void> };
export async function runWorkRetrospectivePolicyCommand(args: string[], factory: () => Promise<PolicyCommandDeps>, write: (text: string) => void): Promise<number> {
  const program = new Command().name("retrospective:policy").allowExcessArguments(false).exitOverride().configureOutput({ writeOut: write, writeErr: write });
  program.argument("<action>", "show, enable or disable").requiredOption("--company <id>").requiredOption("--group <id>")
    .option("--start <timestamp>", "RFC3339 timestamp with timezone")
    .option("--end <timestamp>", "RFC3339 timestamp with timezone")
    .option("--method-version <version>").option("--preview", "preview only; no writes");
  try {
    program.parse(args, { from: "user" });
    const action = program.args[0];
    const opts = program.opts();
    if (!["show", "enable", "disable"].includes(action!)) throw new Error("action must be show, enable or disable");
    const scope = { companyId: opts.company as string, groupId: opts.group as string };
    if (!scope.companyId.trim() || !scope.groupId.trim()) throw new Error("scope must not be empty");
    if (action !== "enable" && (opts.start || opts.end || opts.methodVersion)) throw new Error("period/version options require enable");
    const input: PolicyMutation = action === "enable" ? { action, ...retrospectiveEnableSchema.parse({ ...scope, start: opts.start, end: opts.end, methodVersion: opts.methodVersion }) } : { action: "disable", ...scope };
    const deps = await factory();
    try {
      if (action === "show") deps.write(JSON.stringify(await deps.service.inspect(scope) ?? { ...scope, enabled: false }, null, 2) + "\n");
      else {
        const preview = await deps.service.preview(input);
        deps.write(JSON.stringify(preview, null, 2) + "\n");
        if (!opts.preview) {
          deps.write(`Type exactly: ${preview.confirmation}\n`);
          await deps.service.confirm(input, await deps.readConfirmation());
          deps.write("Policy saved. No messages sent or schedules added.\n");
        }
      }
    } finally { await deps.close(); }
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) return error.code === "commander.helpDisplayed" ? 0 : 1;
    write("Policy command failed: " + (error instanceof Error ? error.message : "unknown error") + "\n");
    return 1;
  }
}
