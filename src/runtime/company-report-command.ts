import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdout } from "node:process";
import { Command } from "commander";
import { z } from "zod";
import type { RetrospectiveRecommendationService } from "../application/retrospective-recommendations.js";
import { CompanyReportingService } from "../application/company-reporting.js";
import { ReportPreflightLlmService } from "../application/report-preflight-llm.js";
import type { ReportPreflightLlmGenerator } from "../application/report-preflight-llm.js";
import { readRoutineDirectoryFile } from "../infrastructure/routine-directory-files.js";
import { hashClientReport } from "../application/report-preflight.js";
import type { ClientReportPublishingService } from "../application/client-report-publishing.js";

export type CompanyReportPreflightDependencies = {
  reporting: Pick<CompanyReportingService, "buildReport">;
  checkLlm: ReportPreflightLlmGenerator;
  recommendations?: Pick<RetrospectiveRecommendationService, "build" | "read" | "check" | "recompute" | "save">;
  publishing?: Pick<ClientReportPublishingService, "resolvePreflightFinding" | "publishClientReport">;
};

export async function runCompanyReportCommand(
  argv: string[],
  dependencies: CompanyReportPreflightDependencies,
  write: (text: string) => void = (text) => stdout.write(text),
): Promise<void> {
  const program = new Command().name("company-report").exitOverride();
  if (dependencies.recommendations) {
    const recommendations = dependencies.recommendations;
    for (const name of ["prepare-recommendations", "check-recommendations", "recompute-recommendations"] as const) {
      const command = program.command(name).requiredOption("--company <companyId>").requiredOption("--group <groupId>");
      if (name !== "prepare-recommendations") command.requiredOption("--artifact <artifactId>");
      if (name === "check-recommendations") command.requiredOption("--decisions <path>");
      command.action(async (options: { company: string; group: string; artifact?: string; decisions?: string }) => {
        const scope = { companyId: options.company, groupId: options.group };
        try {
          const previous = name === "prepare-recommendations" ? undefined : await recommendations.read(scope, options.artifact!);
          if (previous && previous.status !== "applied") { write(`${JSON.stringify(previous)}\n`); return; }
          const result = name === "prepare-recommendations" ? await recommendations.build(scope)
            : name === "recompute-recommendations" ? await recommendations.recompute(scope, (previous as Extract<NonNullable<typeof previous>, { status: "applied" }>).value)
            : await recommendations.check(scope, (previous as Extract<NonNullable<typeof previous>, { status: "applied" }>).value,
              z.strictObject({ operatorId: z.string().trim().min(1), decisions: z.record(z.string().min(1), z.enum(["checked", "rejected"])) }).parse(JSON.parse(await readFile(resolve(options.decisions!), "utf8"))));
          if (result.status !== "applied") { write(`${JSON.stringify(result)}\n`); return; }
          const saved = await recommendations.save(scope, result.value);
          write(`${JSON.stringify(saved.status === "applied" ? { status: "applied", artifactId: result.value.artifactId, version: result.value.version } : saved)}\n`);
        } catch { write(`${JSON.stringify({ status: "failed", code: "validation_error" })}\n`); }
      });
    }
  }
  program.command("build")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .option("--directory <path>")
    .option("--recorded-before <timestamp>")
    .requiredOption("--out <path>")
    .action(async (options: { company: string; group: string; directory?: string; recordedBefore?: string; out: string }) => {
      const directory = options.directory === undefined ? undefined : readRoutineDirectoryFile(
        resolve(options.directory),
        { expectedCompanyId: options.company, requireWorkCategories: true },
      );
      const report = await dependencies.reporting.buildReport({ companyId: options.company, groupId: options.group, ...(directory === undefined ? {} : { directory }), ...(options.recordedBefore === undefined ? {} : { recordedBefore: options.recordedBefore }) });
      await writeFile(resolve(options.out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      write(`${JSON.stringify({ ok: true, out: resolve(options.out) })}\n`);
    });
  program.command("preflight-llm")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .requiredOption("--directory <path>")
    .option("--recorded-before <timestamp>")
    .option("--out <path>")
    .action(async (options: { company: string; group: string; directory: string; recordedBefore?: string; out?: string }) => {
      const directory = readRoutineDirectoryFile(
        resolve(options.directory),
        { expectedCompanyId: options.company, requireWorkCategories: true },
      );
      const report = await dependencies.reporting.buildReport({
        companyId: options.company,
        groupId: options.group,
        directory,
        ...(options.recordedBefore === undefined ? {} : { recordedBefore: options.recordedBefore }),
      });
      const llmFindings = await new ReportPreflightLlmService(dependencies.checkLlm).check({
        routines: [...report.internal.routines
          .filter((routine): routine is typeof routine & { name: string } => routine.name !== undefined)
          .map((routine) => ({
            routineKey: "routineKey" in routine.key ? routine.key.routineKey : routine.key.routineId,
            name: routine.name,
            variants: routine.variants,
          })), ...(report.client.recommendations ?? []).map((recommendation, index) => ({
            routineKey: `recommendation:${index}`, name: recommendation.routine,
            variants: [recommendation.change, recommendation.firstTest, recommendation.expectedSign, recommendation.humanControl, recommendation.stopCondition, ...recommendation.limitations],
          }))],
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
      .requiredOption("--decision <decision>").option("--directory <path>").option("--findings <path>").option("--recorded-before <timestamp>")
      .action(async (options: { company: string; group: string; finding: string; decision: "verified" | "fixed"; directory?: string; findings?: string; recordedBefore?: string }) => {
        if (options.decision !== "verified" && options.decision !== "fixed") throw new Error("--decision must be verified or fixed");
        const directory = options.directory === undefined ? undefined : readRoutineDirectoryFile(resolve(options.directory), { expectedCompanyId: options.company, requireWorkCategories: true });
        const findings = options.findings === undefined ? undefined : JSON.parse(await readFile(resolve(options.findings), "utf8")) as never;
        write(`${JSON.stringify(await dependencies.publishing!.resolvePreflightFinding({ companyId: options.company, groupId: options.group, findingId: options.finding, decision: options.decision, ...(directory === undefined ? {} : { directory }), ...(findings === undefined ? {} : { findings }), ...(options.recordedBefore === undefined ? {} : { recordedBefore: options.recordedBefore }) }))}\n`);
      });
    program.command("publish")
      .requiredOption("--company <companyId>").requiredOption("--group <groupId>")
      .option("--directory <path>").option("--recorded-before <timestamp>").requiredOption("--findings <path>").requiredOption("--out <path>").option("--operator-publish", "Explicit operator acceptance of the current v3 report")
      .action(async (options: { company: string; group: string; directory?: string; recordedBefore?: string; findings: string; out: string; operatorPublish?: boolean }) => {
        const directory = options.directory === undefined ? undefined : readRoutineDirectoryFile(resolve(options.directory), { expectedCompanyId: options.company, requireWorkCategories: true });
        const findings = JSON.parse(await readFile(resolve(options.findings), "utf8")) as never;
        const result = await dependencies.publishing!.publishClientReport({ companyId: options.company, groupId: options.group, ...(directory === undefined ? {} : { directory }), findings, ...(options.operatorPublish ? { operatorDecision: "publish" as const } : {}), ...(options.recordedBefore === undefined ? {} : { recordedBefore: options.recordedBefore }) });
        if (result.ok) await writeFile(resolve(options.out), `${JSON.stringify(result.client, null, 2)}\n`, "utf8");
        write(`${JSON.stringify(result)}\n`);
      });
  }
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (error) {
    // exitOverride keeps commands testable; successful help is not a CLI failure.
    if (error instanceof Error && "code" in error && error.code === "commander.helpDisplayed") return;
    throw error;
  }
}
