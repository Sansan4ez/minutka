import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdout } from "node:process";
import { PilotStatusService } from "../application/pilot-status.js";
import { renderPilotStatusHtml } from "../application/pilot-status-html.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { createPostgresPilotStatusStore } from "../infrastructure/postgres/postgres-pilot-status-store.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { runPilotStatusCommand } from "./pilot-status-command.js";

const pool = createPostgresPool(postgresConfigFromEnv(process.env));
try {
  await runPilotStatusCommand(process.argv.slice(2), {
    generate: async (options) => {
      const migrations = await migrationStatus(pool);
      const healthz = await checkHealth(options.healthzUrl);
      const data = await new PilotStatusService(createPostgresPilotStatusStore(pool)).generate({
        healthz,
        pendingMigrations: migrations.pending.length,
        server: {
          ...(options.commit ? { commit: options.commit } : {}),
          ...(options.backupId ? { backupId: options.backupId } : {}),
          ...(options.smoke ? { smoke: options.smoke } : {}),
          units: options.units,
        },
      });
      const template = await readFile(resolve(options.template), "utf8");
      const output = resolve(options.output);
      await mkdir(dirname(output), { recursive: true });
      const temporary = `${output}.tmp-${process.pid}`;
      await writeFile(temporary, renderPilotStatusHtml(template, data), { encoding: "utf8", mode: 0o640 });
      await rename(temporary, output);
      return { output };
    },
    write: (text) => stdout.write(text),
  });
} finally {
  await pool.end();
}

async function checkHealth(url: string): Promise<"ok" | "failed"> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.ok ? "ok" : "failed";
  } catch {
    return "failed";
  }
}
