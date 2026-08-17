import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { EmployeeDataDeletionService } from "../application/employee-data-deletion.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { createPostgresProfileStore } from "../infrastructure/postgres/postgres-profile-store.js";
import { createMinioClient, minioConfigFromEnv, prepareMinioBucket } from "../infrastructure/minio/minio-config.js";
import { createMinioEmployeeObjectDeletionStore } from "../infrastructure/minio/minio-employee-object-deletion-store.js";

const employeeId = process.argv[2]?.trim();
if (!employeeId) throw new Error("employee_id argument is required");

const confirmation = `DELETE ${employeeId}`;
const terminal = createInterface({ input: stdin, output: stdout });
try {
  stdout.write([
    "This irreversible level-2 operation deletes the employee's personal profile, conversation history, activities, insights, schedules, Telegram binding, onboarding drafts, documents, artifacts, and all MinIO object versions.",
    "It preserves anonymous company rows and an identity-free deletion audit marker.",
    `Type exactly '${confirmation}' to continue: `,
  ].join("\n"));
  if ((await terminal.question("")).trim() !== confirmation) {
    throw new Error("confirmation did not match; nothing was deleted");
  }
} finally {
  terminal.close();
}

const config = postgresConfigFromEnv(process.env);
const pool = createPostgresPool(config);
try {
  const status = await migrationStatus(pool);
  if (status.pending.length) {
    throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
  }
  const minioConfig = minioConfigFromEnv(process.env);
  const minioClient = createMinioClient(minioConfig);
  await prepareMinioBucket(minioClient, minioConfig.bucket);
  const deletion = new EmployeeDataDeletionService(
    createPostgresProfileStore(pool, config.inviteCodePepper),
    createMinioEmployeeObjectDeletionStore({ client: minioClient, bucket: minioConfig.bucket }),
  );
  stdout.write(`${JSON.stringify(await deletion.deleteEmployeeData({ employeeId }), null, 2)}\n`);
} finally {
  await pool.end();
}
