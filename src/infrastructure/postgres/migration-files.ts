import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type MigrationFile = { version: string; name: string; sql: string; checksum: string };
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../../migrations");

export async function loadMigrationFiles(): Promise<MigrationFile[]> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort((left, right) => Number(left.split("_", 1)[0]) - Number(right.split("_", 1)[0]));
  const migrations = await Promise.all(files.map(async (file) => {
    const sql = await readFile(join(migrationsDirectory, file), "utf8");
    const [version, ...rest] = file.replace(/\.sql$/, "").split("_");
    return { version, name: rest.join("_"), sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
  const duplicate = migrations.find((migration, index) => migrations.findIndex(({ version }) => version === migration.version) !== index);
  if (duplicate) throw new Error(`duplicate migration version: ${duplicate.version}`);
  return migrations;
}
