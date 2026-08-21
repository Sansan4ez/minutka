import { stdout } from "node:process";
import { ResearchCorpusExportService } from "../application/research-corpus-export.js";
import { ResearchEvaluationService } from "../application/research-evaluation.js";
import { ResearchEvidenceReadService } from "../application/research-evidence-read.js";
import { createPostgresAuditEventStore } from "../infrastructure/postgres/postgres-audit-event-store.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresEvaluationCaseStore } from "../infrastructure/postgres/postgres-evaluation-case-store.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { createPostgresResearchCorpusSource } from "../infrastructure/postgres/postgres-research-corpus-source.js";
import { createPostgresResearchTraceStore } from "../infrastructure/postgres/postgres-research-trace-store.js";
import { runResearchCorpusCommand } from "./research-corpus-command.js";

const pool = createPostgresPool(postgresConfigFromEnv(process.env));
try {
  const status = await migrationStatus(pool);
  if (status.pending.length) throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
  const traces = createPostgresResearchTraceStore(pool);
  const evaluations = createPostgresEvaluationCaseStore(pool);
  const audit = createPostgresAuditEventStore(pool);
  await runResearchCorpusCommand(process.argv.slice(2), {
    exportService: new ResearchCorpusExportService(
      createPostgresResearchCorpusSource(pool),
      traces,
      evaluations,
      audit,
    ),
    evaluationService: new ResearchEvaluationService(evaluations, traces),
    evidenceReadService: new ResearchEvidenceReadService(evaluations, traces, audit),
    write: (text) => stdout.write(text),
  });
} finally {
  await pool.end();
}
