import { writeFile } from "node:fs/promises";
import { stdout } from "node:process";
import { resolve } from "node:path";
import { Command } from "commander";
import {
  measureRoleSection,
  RoutineDirectoryError,
  routineDirectoryCounts,
  routineDirectorySectionBudget,
} from "../application/routine-directory.js";
import { runRoutineDirectoryPurge } from "./routine-directory-purge-command.js";
import { RoutineDirectorySuggestService } from "../application/routine-directory-suggest.js";
import { suggestRoutineDirectoryWithAgent } from "../mastra/routine-directory-suggester.js";
import { ResearchEvidenceReadService } from "../application/research-evidence-read.js";
import { createPostgresAuditEventStore } from "../infrastructure/postgres/postgres-audit-event-store.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresEvaluationCaseStore } from "../infrastructure/postgres/postgres-evaluation-case-store.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { createPostgresResearchCorpusSource } from "../infrastructure/postgres/postgres-research-corpus-source.js";
import { createPostgresResearchTraceStore } from "../infrastructure/postgres/postgres-research-trace-store.js";
import { readRoutineDirectoryFile } from "../infrastructure/routine-directory-files.js";
import { loadDotEnv } from "../config/env.js";

export async function runRoutineDirectoryCommand(argv: string[], write: (text: string) => void = (text) => stdout.write(text)): Promise<void> {
  const program = new Command().name("routine-directory").exitOverride();
  program.command("validate")
    .requiredOption("--company <companyId>")
    .requiredOption("--file <path>")
    .action(async (options: { company: string; file: string }) => {
      try {
        const directory = readRoutineDirectoryFile(resolve(options.file), { expectedCompanyId: options.company });
        const sections = directory.sections.map(({ roleId }) => measureRoleSection(directory, roleId));
        const overBudget = sections.filter(({ entries, characters }) => (
          entries > routineDirectorySectionBudget.maximumEntries
          || characters > routineDirectorySectionBudget.maximumCharacters
        ));
        const result = {
          ok: overBudget.length === 0,
          ...(overBudget.length === 0 ? {} : { code: "directory_section_over_budget", overBudget }),
          version: directory.version,
          ...routineDirectoryCounts(directory),
          sections,
          budget: routineDirectorySectionBudget,
        };
        write(`${JSON.stringify(result, null, 2)}\n`);
      } catch (error) {
        if (!(error instanceof RoutineDirectoryError)) throw error;
        write(`${JSON.stringify({ ok: false, code: error.code, message: error.message }, null, 2)}\n`);
      }
    });
  program.command("purge")
    .requiredOption("--company <companyId>")
    .option("--group <groupId>")
    .option("--subject-key <subjectKey>")
    .requiredOption("--dir <versionsDir>")
    .option("--dry-run")
    .action(async (options: { company: string; group?: string; subjectKey?: string; dir: string; dryRun?: boolean }) => {
      await runRoutineDirectoryPurge({
        company: options.company,
        ...(options.group === undefined ? {} : { group: options.group }),
        ...(options.subjectKey === undefined ? {} : { subjectKey: options.subjectKey }),
        dir: options.dir,
        dryRun: options.dryRun,
      }, write);
    });
  program.command("suggest")
    .requiredOption("--company <companyId>")
    .requiredOption("--group <groupId>")
    .requiredOption("--file <path>")
    .option("--out <path>")
    .action(async (options: { company: string; group: string; file: string; out?: string }) => {
      loadDotEnv();
      const directory = readRoutineDirectoryFile(resolve(options.file), { expectedCompanyId: options.company });
      const pool = createPostgresPool(postgresConfigFromEnv(process.env));
      try {
        const status = await migrationStatus(pool);
        if (status.pending.length) throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
        const traces = createPostgresResearchTraceStore(pool);
        const evidenceRead = new ResearchEvidenceReadService(
          createPostgresEvaluationCaseStore(pool),
          traces,
          createPostgresAuditEventStore(pool),
          undefined,
          undefined,
          createPostgresResearchCorpusSource(pool),
        );
        const pack = await new RoutineDirectorySuggestService(evidenceRead, suggestRoutineDirectoryWithAgent).suggest({
          companyId: options.company,
          groupId: options.group,
          directory,
        });
        const output = `${JSON.stringify(pack, null, 2)}\n`;
        if (options.out) await writeFile(resolve(options.out), output, "utf8");
        else write(output);
      } finally {
        await pool.end();
      }
    });
  await program.parseAsync(argv, { from: "user" });
}

if (process.argv[1]?.endsWith("/routine-directory.ts") || process.argv[1]?.endsWith("/routine-directory.js")) {
  await runRoutineDirectoryCommand(process.argv.slice(2));
}
