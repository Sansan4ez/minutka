import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type MigrationFile = { version: string; name: string; sql: string; checksum: string };
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../../migrations");

export async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const files = (await readdir(migrationsDirectory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  return Promise.all(files.map(async (file) => {
    const sql = await readFile(join(migrationsDirectory, file), "utf8");
    const [version, ...rest] = file.replace(/\.sql$/, "").split("_");
    return { version, name: rest.join("_"), sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}
