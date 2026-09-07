import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdout } from "node:process";
import { Command } from "commander";
import { CompanyReportingService } from "../application/company-reporting.js";
import { ReportPreflightLlmService } from "../application/report-preflight-llm.js";
import type { ReportPreflightLlmGenerator } from "../application/report-preflight-llm.js";
import { loadRoutineDirectory } from "../application/routine-directory.js";

export type CompanyReportPreflightDependencies = {
  reporting: Pick<CompanyReportingService, "buildReport">;
  checkLlm: ReportPreflightLlmGenerator;
};

export async function runCompanyReportCommand(
  argv: string[],
  dependencies: CompanyReportPreflightDependencies,
  write: (text: string) => void = (text) => stdout.write(text),
): Promise<void> {
  const program = new Command().name("company-report").exitOverride();
  program.command("preflight-llm")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .requiredOption("--directory <path>")
    .option("--out <path>")
    .action(async (options: { company: string; group: string; directory: string; out?: string }) => {
      const directory = loadRoutineDirectory(
        JSON.parse(await readFile(resolve(options.directory), "utf8")) as unknown,
        { expectedCompanyId: options.company },
      );
      const report = await dependencies.reporting.buildReport({
        companyId: options.company,
        groupId: options.group,
        directory,
      });
      const llmFindings = await new ReportPreflightLlmService(dependencies.checkLlm).check({
        routines: report.internal.routines
          .filter((routine): routine is typeof routine & { name: string } => routine.name !== undefined)
          .map((routine) => ({
            routineKey: "routineKey" in routine.key ? routine.key.routineKey : routine.key.routineId,
            name: routine.name,
            variants: routine.variants,
          })),
      });
      const findings = [...report.internal.preflightFindings, ...llmFindings];
      const output = `${JSON.stringify(findings, null, 2)}\n`;
      if (options.out) await writeFile(resolve(options.out), output, "utf8");
      else write(output);
    });
  await program.parseAsync(argv, { from: "user" });
}
