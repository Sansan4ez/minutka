import { Command } from "commander";
import type { EvaluationHumanLabels, ResearchEvaluationService } from "../application/research-evaluation.js";
import type { ResearchEvidenceReadService } from "../application/research-evidence-read.js";
import type { ResearchCorpusExportService, ResearchCorpusFormat } from "../application/research-corpus-export.js";

export type ResearchCorpusCommandDeps = {
  exportService: Pick<ResearchCorpusExportService, "export">;
  evaluationService: Pick<ResearchEvaluationService, "create" | "get">;
  evidenceReadService: Pick<ResearchEvidenceReadService, "listEvaluationCases" | "listTraces" | "getTrace">;
  write(text: string): void;
};

export async function runResearchCorpusCommand(argv: string[], deps: ResearchCorpusCommandDeps): Promise<void> {
  const program = new Command().name("research-corpus").exitOverride();
  program.command("export")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .option("--format <format>", "json|jsonl|markdown", parseFormat, "json")
    .action(async (options: { company: string; group: string; format: ResearchCorpusFormat }) => {
      const result = await deps.exportService.export({ companyId: options.company, groupId: options.group, format: options.format });
      deps.write(result.content);
    });
  const evaluation = program.command("evaluation");
  evaluation.command("create")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .requiredOption("--trace <traceId>")
    .requiredOption("--usefulness <label>")
    .requiredOption("--accuracy <label>")
    .requiredOption("--clarification <label>")
    .requiredOption("--extraction <label>")
    .option("--notes <text>")
    .action(async (options: Record<string, string | undefined>) => {
      const labels = {
        usefulness: options.usefulness,
        accuracy: options.accuracy,
        clarification: options.clarification,
        extractionCorrectness: options.extraction,
        ...(options.notes ? { notes: options.notes } : {}),
      } as EvaluationHumanLabels;
      deps.write(`${JSON.stringify(await deps.evaluationService.create({ companyId: options.company!, groupId: options.group!, traceId: options.trace!, labels }), null, 2)}\n`);
    });
  evaluation.command("get")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .requiredOption("--case <caseId>")
    .action(async (options: { company: string; group: string; case: string }) => {
      const record = await deps.evaluationService.get({ companyId: options.company, groupId: options.group, caseId: options.case });
      if (!record) throw new Error("evaluation case not found in the requested company/group scope");
      deps.write(`${JSON.stringify(record, null, 2)}\n`);
    });
  evaluation.command("list")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .action(async (options: { company: string; group: string }) => {
      deps.write(`${JSON.stringify(await deps.evidenceReadService.listEvaluationCases({ companyId: options.company, groupId: options.group }), null, 2)}\n`);
    });
  const traces = program.command("traces");
  traces.command("list")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .option("--subject <subjectKey>")
    .option("--trace <traceId>")
    .option("--from <date>", "inclusive trace startedAt lower bound")
    .option("--to <date>", "inclusive trace startedAt upper bound")
    .action(async (options: { company: string; group: string; subject?: string; trace?: string; from?: string; to?: string }) => {
      deps.write(`${JSON.stringify(await deps.evidenceReadService.listTraces({
        companyId: options.company,
        groupId: options.group,
        ...(options.subject ? { subjectKey: options.subject } : {}),
        ...(options.trace ? { traceId: options.trace } : {}),
        ...(options.from ? { from: options.from } : {}),
        ...(options.to ? { to: options.to } : {}),
      }), null, 2)}\n`);
    });
  traces.command("get")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .requiredOption("--trace <traceId>")
    .action(async (options: { company: string; group: string; trace: string }) => {
      const record = await deps.evidenceReadService.getTrace({ companyId: options.company, groupId: options.group, traceId: options.trace });
      if (!record) throw new Error("research trace not found in the requested company/group scope");
      deps.write(`${JSON.stringify(record, null, 2)}\n`);
    });
  await program.parseAsync(argv, { from: "user" });
}

function parseFormat(value: string): ResearchCorpusFormat {
  if (value === "json" || value === "jsonl" || value === "markdown") return value;
  throw new Error("format must be json, jsonl, or markdown");
}
