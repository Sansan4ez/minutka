import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RoutineAssignmentReplayService } from "../application/routine-assignment-replay.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { postgresMigrationConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { createPostgresRoutineAssignmentReplayStore } from "../infrastructure/postgres/postgres-routine-assignment-replay-store.js";

export function parseRoutineAssignmentReplayArguments(args: string[]): { file: string } {
  if (args.length !== 2 || args[0] !== "--file" || !args[1]?.trim()) throw usageError();
  return { file: resolve(args[1]) };
}

async function main(): Promise<void> {
  const { file } = parseRoutineAssignmentReplayArguments(process.argv.slice(2));
  const pool = createPostgresPool({ ...postgresMigrationConfigFromEnv(process.env), statementTimeoutMillis: 0 });
  try {
    const status = await migrationStatus(pool);
    if (status.pending.length) throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
    const service = new RoutineAssignmentReplayService(createPostgresRoutineAssignmentReplayStore(pool));
    const result = await service.replay(JSON.parse(await readFile(file, "utf8")) as unknown);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

function usageError(): Error {
  return new Error("usage: minutka-routine-assignment-replay --file <reviewed-assignments.json>");
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "routine assignment replay failed");
    process.exitCode = 1;
  });
}
