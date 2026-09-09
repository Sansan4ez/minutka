import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RoutineAssignmentReplayService, routineAssignmentReplayInputSchema } from "../application/routine-assignment-replay.js";
import { readRoutineDirectoryFile } from "../infrastructure/routine-directory-files.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { postgresMigrationConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { createPostgresRoutineAssignmentReplayStore } from "../infrastructure/postgres/postgres-routine-assignment-replay-store.js";

export function parseRoutineAssignmentReplayArguments(args: string[]): { file: string; directory: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--file" && flag !== "--directory") || !value?.trim() || values.has(flag)) throw usageError();
    values.set(flag, value);
  }
  const file = values.get("--file");
  const directory = values.get("--directory");
  if (!file || !directory || args.length !== 4) throw usageError();
  return { file: resolve(file), directory: resolve(directory) };
}

async function main(): Promise<void> {
  const { file, directory: directoryPath } = parseRoutineAssignmentReplayArguments(process.argv.slice(2));
  const rawInput = JSON.parse(await readFile(file, "utf8")) as unknown;
  const parsedInput = routineAssignmentReplayInputSchema.parse(rawInput);
  const directory = readRoutineDirectoryFile(directoryPath, { expectedCompanyId: parsedInput.companyId });
  const pool = createPostgresPool({ ...postgresMigrationConfigFromEnv(process.env), statementTimeoutMillis: 0 });
  try {
    const status = await migrationStatus(pool);
    if (status.pending.length) throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
    const service = new RoutineAssignmentReplayService(createPostgresRoutineAssignmentReplayStore(pool));
    const result = await service.replay(parsedInput, directory);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await pool.end();
  }
}

function usageError(): Error {
  return new Error("usage: minutka-routine-assignment-replay --file <reviewed-assignments.json> --directory <routine-directory.json>");
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "routine assignment replay failed");
    process.exitCode = 1;
  });
}
