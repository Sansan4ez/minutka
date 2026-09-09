import { readdir, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
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

type PurgeFileOperations = {
  unlink(path: string): Promise<void>;
  writeJson(path: string, value: unknown): Promise<void>;
};

const defaultFileOperations: PurgeFileOperations = {
  unlink,
  async writeJson(path, value) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  },
};

export async function runRoutineDirectoryPurge(
  options: PurgeOptions,
  write: (text: string) => void,
  env: NodeJS.ProcessEnv = process.env,
  fileOperations: PurgeFileOperations = defaultFileOperations,
): Promise<void> {
  if (options.subjectKey !== undefined && options.group === undefined) {
    throw new Error("--subject-key requires --group");
  }
  const directoryPath = resolve(resolveDirectoryDir(options.dir, env));
  const tombstonePath = join(directoryPath, `routine-directory.${options.company}.tombstones.json`);
  const activePath = join(directoryPath, `routine-directory.${options.company}.json`);
  const tombstoneIds = readTombstones(directoryPath, options.company);
  const scope: RoutineDirectoryPurgeScope = options.group === undefined
    ? "company"
    : options.subjectKey === undefined
      ? { groupId: options.group }
      : { groupId: options.group, subjectKey: options.subjectKey };
  const { files, unparsedPaths } = await readDirectoryFiles(directoryPath, options.company, scope);
  const activeFile = files.find(({ path }) => path === activePath);
  const plan = planDirectoryPurge({
    files,
    scope,
    ...(activeFile === undefined ? {} : { currentFile: activeFile }),
  });
  const nextTombstones = [...new Set([...tombstoneIds, ...plan.affectedEntryIds])].sort();
  const pathsToDelete = [...new Set([...plan.filesToDelete, ...unparsedPaths])].sort();

  if (!options.dryRun) {
    if (nextTombstones.length !== tombstoneIds.length) {
      await fileOperations.writeJson(tombstonePath, { ids: nextTombstones });
    }
    if (plan.survivingVersion !== undefined) {
      await fileOperations.writeJson(plan.survivingVersion.path, plan.survivingVersion.directory);
      await fileOperations.writeJson(activePath, plan.survivingVersion.directory);
    }
    for (const path of pathsToDelete) await fileOperations.unlink(path);
  }

  write(`${JSON.stringify({
    affectedEntries: plan.affectedEntryIds.length,
    filesDeleted: pathsToDelete.length,
    unparsedFilesDeleted: unparsedPaths.length,
    survivingVersion: plan.survivingVersion !== undefined ? 1 : 0,
    activeFileFallback: activeFile === undefined && files.length > 0 ? 1 : 0,
    tombstones: nextTombstones.length,
    runtimeRestartRequired: plan.affectedEntryIds.length > 0 || unparsedPaths.length > 0,
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
  scope: RoutineDirectoryPurgeScope,
): Promise<{ files: DirectoryFile[]; unparsedPaths: string[] }> {
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const prefix = `routine-directory.${companyId}`;
  const paths = entries
    .filter((file) => file.isFile() && (file.name === `${prefix}.json` || (file.name.startsWith(`${prefix}.`) && file.name.endsWith(".json") && !file.name.endsWith(".tombstones.json"))))
    .map(({ name }) => join(directoryPath, name))
    .sort();
  const files: DirectoryFile[] = [];
  const unparsedPaths: string[] = [];
  for (const path of paths) {
    try {
      files.push({
        path,
        directory: readRoutineDirectoryFile(path, { expectedCompanyId: companyId, tombstones: "ignore" }),
      });
    } catch (error) {
      if (scope === "company") {
        unparsedPaths.push(path);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new RoutineDirectoryError(
        error instanceof RoutineDirectoryError ? error.code : "directory_schema_invalid",
        `cannot scan routine directory copy ${JSON.stringify(basename(path))} for purge: ${message}; fix or delete this copy according to the purge runbook, then retry`,
      );
    }
  }
  return { files, unparsedPaths };
}
