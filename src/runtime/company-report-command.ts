import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdout } from "node:process";
import { Command } from "commander";
import { CompanyReportingService } from "../application/company-reporting.js";
import { ReportPreflightLlmService } from "../application/report-preflight-llm.js";
import type { ReportPreflightLlmGenerator } from "../application/report-preflight-llm.js";
import { readRoutineDirectoryFile } from "../infrastructure/routine-directory-files.js";
import { hashClientReport } from "../application/report-preflight.js";
import type { ClientReportPublishingService } from "../application/client-report-publishing.js";

export type CompanyReportPreflightDependencies = {
  reporting: Pick<CompanyReportingService, "buildReport">;
  checkLlm: ReportPreflightLlmGenerator;
  publishing?: Pick<ClientReportPublishingService, "resolvePreflightFinding" | "publishClientReport">;
};

export async function runCompanyReportCommand(
  argv: string[],
  dependencies: CompanyReportPreflightDependencies,
  write: (text: string) => void = (text) => stdout.write(text),
): Promise<void> {
  const program = new Command().name("company-report").exitOverride();
  program.command("build")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .option("--directory <path>")
    .requiredOption("--out <path>")
    .action(async (options: { company: string; group: string; directory?: string; out: string }) => {
      const directory = options.directory === undefined ? undefined : readRoutineDirectoryFile(
        resolve(options.directory),
        { expectedCompanyId: options.company },
      );
      const report = await dependencies.reporting.buildReport({ companyId: options.company, groupId: options.group, ...(directory === undefined ? {} : { directory }) });
      await writeFile(resolve(options.out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      write(`${JSON.stringify({ ok: true, out: resolve(options.out) })}\n`);
    });
  program.command("preflight-llm")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .requiredOption("--directory <path>")
    .option("--out <path>")
    .action(async (options: { company: string; group: string; directory: string; out?: string }) => {
      const directory = readRoutineDirectoryFile(
        resolve(options.directory),
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
      const output = `${JSON.stringify({
        schemaVersion: "minutka-report-preflight-findings/v1",
        scope: `${options.company}/${options.group}`,
        reportVersion: hashClientReport(report.client),
        findings,
      }, null, 2)}\n`;
      if (options.out) await writeFile(resolve(options.out), output, "utf8");
      else write(output);
    });
  if (dependencies.publishing) {
    program.command("resolve-finding")
      .requiredOption("--company <companyId>").requiredOption("--group <groupId>").requiredOption("--finding <findingId>")
      .requiredOption("--decision <decision>").option("--directory <path>").option("--findings <path>")
      .action(async (options: { company: string; group: string; finding: string; decision: "verified" | "fixed"; directory?: string; findings?: string }) => {
        if (options.decision !== "verified" && options.decision !== "fixed") throw new Error("--decision must be verified or fixed");
        const directory = options.directory === undefined ? undefined : readRoutineDirectoryFile(resolve(options.directory), { expectedCompanyId: options.company });
        const findings = options.findings === undefined ? undefined : JSON.parse(await readFile(resolve(options.findings), "utf8")) as never;
        write(`${JSON.stringify(await dependencies.publishing!.resolvePreflightFinding({ companyId: options.company, groupId: options.group, findingId: options.finding, decision: options.decision, ...(directory === undefined ? {} : { directory }), ...(findings === undefined ? {} : { findings }) }))}\n`);
      });
    program.command("publish")
      .requiredOption("--company <companyId>").requiredOption("--group <groupId>")
      .option("--directory <path>").requiredOption("--findings <path>").requiredOption("--out <path>")
      .action(async (options: { company: string; group: string; directory?: string; findings: string; out: string }) => {
        const directory = options.directory === undefined ? undefined : readRoutineDirectoryFile(resolve(options.directory), { expectedCompanyId: options.company });
        const findings = JSON.parse(await readFile(resolve(options.findings), "utf8")) as never;
        const result = await dependencies.publishing!.publishClientReport({ companyId: options.company, groupId: options.group, ...(directory === undefined ? {} : { directory }), findings });
        if (result.ok) await writeFile(resolve(options.out), `${JSON.stringify(result.client, null, 2)}\n`, "utf8");
        write(`${JSON.stringify(result)}\n`);
      });
  }
  await program.parseAsync(argv, { from: "user" });
}
