import { Command } from "commander";
import type { PilotStatusService } from "../application/pilot-status.js";

export type PilotStatusCommandOptions = {
  output: string;
  template: string;
  healthzUrl: string;
  commit?: string;
  backupId?: string;
  smoke?: string;
  units: Array<{ name: string; status: string }>;
};

export type PilotStatusCommandDeps = {
  generate(options: PilotStatusCommandOptions): Promise<{ output: string }>;
  write(text: string): void;
};

export async function runPilotStatusCommand(argv: string[], deps: PilotStatusCommandDeps): Promise<void> {
  const program = new Command().name("pilot-status").exitOverride();
  program
    .option("--output <path>", "self-contained HTML output path", process.env.PILOT_STATUS_OUTPUT ?? "reports/pilot-status-latest.html")
    .option("--template <path>", "HTML template", process.env.PILOT_STATUS_TEMPLATE ?? "docs/reports/pilot-status-template.html")
    .option("--healthz-url <url>", "application health endpoint", process.env.PILOT_STATUS_HEALTHZ_URL ?? "http://127.0.0.1:8787/healthz")
    .option("--commit <sha>", "deployed commit", process.env.PILOT_STATUS_COMMIT)
    .option("--backup-id <id>", "latest backup id", process.env.PILOT_STATUS_BACKUP_ID)
    .option("--smoke <status>", "server smoke status", process.env.PILOT_STATUS_SMOKE)
    .option("--unit <name=status...>", "server unit status; repeatable", collectUnit, [])
    .action(async (options: Record<string, unknown>) => {
      const result = await deps.generate({
        output: String(options.output),
        template: String(options.template),
        healthzUrl: String(options.healthzUrl),
        ...(options.commit ? { commit: String(options.commit) } : {}),
        ...(options.backupId ? { backupId: String(options.backupId) } : {}),
        ...(options.smoke ? { smoke: String(options.smoke) } : {}),
        units: options.unit as Array<{ name: string; status: string }>,
      });
      deps.write(`${result.output}\n`);
    });
  await program.parseAsync(argv, { from: "user" });
}

function collectUnit(value: string, previous: Array<{ name: string; status: string }>): Array<{ name: string; status: string }> {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) throw new Error("--unit must use name=status");
  return [...previous, { name: value.slice(0, separator), status: value.slice(separator + 1) }];
}

export type PilotStatusGenerator = Pick<PilotStatusService, "generate">;
