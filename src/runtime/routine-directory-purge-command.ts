import { readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RoutineDirectoryError, type RoutineDirectory } from "../application/routine-directory.js";
import { routineDirectoryRuntimeConfigFromEnv } from "../config/routine-directory.js";
import { readRoutineDirectoryFile, readTombstones } from "../infrastructure/routine-directory-files.js";
import {
  planDirectoryPurge,
  type RoutineDirectoryPurgeScope,
} from "../application/routine-directory-purge.js";

type DirectoryFile = { path: string; directory: RoutineDirectory };

type PurgeOptions = {
  company: string;
  group?: string;
  subjectKey?: string;
  /** Overrides ROUTINE_DIRECTORY_DIR; the active file, versions and tombstones share this one directory. */
  dir?: string;
  dryRun?: boolean;
};

export async function runRoutineDirectoryPurge(
  options: PurgeOptions,
  write: (text: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (options.subjectKey !== undefined && options.group === undefined) {
    throw new Error("--subject-key requires --group");
  }
  const directoryPath = resolve(resolveDirectoryDir(options.dir, env));
  const tombstonePath = join(directoryPath, `routine-directory.${options.company}.tombstones.json`);
  const tombstoneIds = readTombstones(directoryPath, options.company);
  const files = await readDirectoryFiles(directoryPath, options.company);
  const scope: RoutineDirectoryPurgeScope = options.group === undefined
    ? "company"
    : options.subjectKey === undefined
      ? { groupId: options.group }
      : { groupId: options.group, subjectKey: options.subjectKey };
  const plan = planDirectoryPurge({ files, scope });
  const nextTombstones = [...new Set([...tombstoneIds, ...plan.affectedEntryIds])].sort();

  if (!options.dryRun) {
    for (const path of plan.filesToDelete) await unlink(path);
    if (plan.survivingVersion !== undefined) {
      await writeJson(plan.survivingVersion.path, plan.survivingVersion.directory);
      await writeJson(join(directoryPath, `routine-directory.${options.company}.json`), plan.survivingVersion.directory);
    }
    if (nextTombstones.length !== tombstoneIds.length) {
      await writeJson(tombstonePath, { ids: nextTombstones });
    }
  }

  write(`${JSON.stringify({
    affectedEntries: plan.affectedEntryIds.length,
    filesDeleted: plan.filesToDelete.length,
    survivingVersion: plan.survivingVersion !== undefined ? 1 : 0,
    tombstones: nextTombstones.length,
    runtimeRestartRequired: plan.filesToDelete.length > 0,
  })}\n`);
}

function resolveDirectoryDir(dir: string | undefined, env: NodeJS.ProcessEnv): string {
  const configured = dir?.trim() || routineDirectoryRuntimeConfigFromEnv(env).directory;
  if (!configured) {
    throw new RoutineDirectoryError("directory_dir_not_configured", "routine directory dir is not configured: pass --dir or set ROUTINE_DIRECTORY_DIR");
  }
  return configured;
}

async function readDirectoryFiles(
  directoryPath: string,
  companyId: string,
): Promise<DirectoryFile[]> {
  const files = await readdir(directoryPath, { withFileTypes: true });
  const prefix = `routine-directory.${companyId}`;
  const paths = files
    .filter((file) => file.isFile() && file.name.startsWith(`${prefix}.`) && file.name.endsWith(".json") && !file.name.endsWith(".tombstones.json"))
    .map(({ name }) => join(directoryPath, name))
    .sort();
  const result: DirectoryFile[] = [];
  for (const path of paths) {
    result.push({ path, directory: readRoutineDirectoryFile(path, { expectedCompanyId: companyId }) });
  }
  return result;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

