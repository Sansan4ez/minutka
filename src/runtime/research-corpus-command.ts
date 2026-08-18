import { Command } from "commander";
import type { EvaluationHumanLabels, ResearchEvaluationService } from "../application/research-evaluation.js";
import type { ResearchCorpusExportService, ResearchCorpusFormat } from "../application/research-corpus-export.js";

export type ResearchCorpusCommandDeps = {
  exportService: Pick<ResearchCorpusExportService, "export">;
  evaluationService: Pick<ResearchEvaluationService, "create" | "get">;
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
  await program.parseAsync(argv, { from: "user" });
}

function parseFormat(value: string): ResearchCorpusFormat {
  if (value === "json" || value === "jsonl" || value === "markdown") return value;
  throw new Error("format must be json, jsonl, or markdown");
}
