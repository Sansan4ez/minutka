import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ResearchScopePurgeService } from "../application/research-scope-purge.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { createPostgresResearchScopePurgeStore } from "../infrastructure/postgres/postgres-research-scope-purge-store.js";
import { createMinioClient, minioConfigFromEnv, prepareMinioBucket } from "../infrastructure/minio/minio-config.js";
import { createMinioEmployeeObjectDeletionStore } from "../infrastructure/minio/minio-employee-object-deletion-store.js";
import { runResearchScopePurgeCommand } from "./research-scope-purge-command.js";

const pool = createPostgresPool(postgresConfigFromEnv(process.env));
const terminal = createInterface({ input: stdin, output: stdout });
try {
  const status = await migrationStatus(pool);
  if (status.pending.length) {
    throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
  }
  const minioConfig = minioConfigFromEnv(process.env);
  const minioClient = createMinioClient(minioConfig);
  await prepareMinioBucket(minioClient, minioConfig.bucket);
  await runResearchScopePurgeCommand(process.argv.slice(2), {
    service: new ResearchScopePurgeService(
      createPostgresResearchScopePurgeStore(pool),
      createMinioEmployeeObjectDeletionStore({ client: minioClient, bucket: minioConfig.bucket }),
    ),
    readConfirmation: () => terminal.question(""),
    write: (text) => stdout.write(text),
  });
} finally {
  terminal.close();
  await pool.end();
}
