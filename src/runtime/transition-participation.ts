import { createInterface } from "node:readline/promises";
import { loadDotEnv } from "../config/env.js";
import { ParticipationTransitionService, participationTransitionSchema } from "../application/participation-transition.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { createPostgresParticipationTransitionStore } from "../infrastructure/postgres/postgres-participation-transition-store.js";

loadDotEnv();
const [companyId, sourceGroupId, targetGroupId, sourceEmployeeId, targetEmployeeId] = process.argv.slice(2);
const input = participationTransitionSchema.parse({ companyId, sourceGroupId, targetGroupId, sourceEmployeeId, targetEmployeeId });
if (process.env.PARTICIPATION_TRANSITION_RUNTIME_STOPPED !== "true") throw new Error("Stop runtime and set PARTICIPATION_TRANSITION_RUNTIME_STOPPED=true");
const terminal = createInterface({ input: process.stdin, output: process.stdout });
try {
  const confirmation = `TRANSITION ${input.sourceEmployeeId} ${input.targetEmployeeId}`;
  if (await terminal.question(`Scope: ${JSON.stringify(input)}\nType exactly '${confirmation}': `) !== confirmation) throw new Error("confirmation did not match; nothing changed");
} finally { terminal.close(); }
const pool = createPostgresPool(postgresConfigFromEnv(process.env));
try {
  if ((await migrationStatus(pool)).pending.length) throw new Error("pending migrations");
  const service = new ParticipationTransitionService(createPostgresParticipationTransitionStore(pool));
  process.stdout.write(`${JSON.stringify(await service.transition(input))}\n`);
} finally { await pool.end(); }
