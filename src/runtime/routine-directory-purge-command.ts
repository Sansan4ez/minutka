import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  loadRoutineDirectory,
  loadRoutineDirectoryTombstones,
  type RoutineDirectory,
} from "../application/routine-directory.js";
import {
  planDirectoryPurge,
  type RoutineDirectoryPurgeScope,
} from "../application/routine-directory-purge.js";

type DirectoryFile = { path: string; directory: RoutineDirectory };

type PurgeOptions = {
  company: string;
  group?: string;
  subjectKey?: string;
  dir: string;
  dryRun?: boolean;
};

export async function runRoutineDirectoryPurge(options: PurgeOptions, write: (text: string) => void): Promise<void> {
  if (options.subjectKey !== undefined && options.group === undefined) {
    throw new Error("--subject-key requires --group");
  }
  const directoryPath = resolve(options.dir);
  const tombstonePath = join(directoryPath, `routine-directory.${options.company}.tombstones.json`);
  const tombstoneIds = await readTombstones(tombstonePath);
  const files = await readDirectoryFiles(directoryPath, options.company, new Set(tombstoneIds));
  const scope: RoutineDirectoryPurgeScope = options.group === undefined
    ? "company"
    : options.subjectKey === undefined
      ? { groupId: options.group }
      : { groupId: options.group, subjectKey: options.subjectKey };
  const plan = planDirectoryPurge({ files, scope });
  const nextTombstones = [...new Set([...tombstoneIds, ...plan.affectedEntryIds])].sort();

  if (!options.dryRun) {
    if (plan.survivingVersion !== undefined) {
      await writeJson(plan.survivingVersion.path, plan.survivingVersion.directory);
    }
    for (const path of plan.filesToDelete) await unlink(path);
    if (nextTombstones.length !== tombstoneIds.length) {
      await writeJson(tombstonePath, { ids: nextTombstones });
    }
  }

  write(`${JSON.stringify({
    affectedEntries: plan.affectedEntryIds.length,
    filesDeleted: plan.filesToDelete.length,
    survivingVersion: plan.survivingVersion !== undefined ? 1 : 0,
    tombstones: nextTombstones.length,
  })}\n`);
}

async function readDirectoryFiles(
  directoryPath: string,
  companyId: string,
  tombstoneIds: ReadonlySet<string>,
): Promise<DirectoryFile[]> {
  const files = await readdir(directoryPath, { withFileTypes: true });
  const prefix = `routine-directory.${companyId}`;
  const paths = files
    .filter((file) => file.isFile() && file.name.startsWith(`${prefix}.`) && file.name.endsWith(".json") && !file.name.endsWith(".tombstones.json"))
    .map(({ name }) => join(directoryPath, name))
    .sort();
  const result: DirectoryFile[] = [];
  for (const path of paths) {
    const json = JSON.parse(await readFile(path, "utf8")) as unknown;
    result.push({ path, directory: loadRoutineDirectory(json, { expectedCompanyId: companyId, tombstoneIds }) });
  }
  return result;
}

async function readTombstones(path: string): Promise<string[]> {
  try {
    return loadRoutineDirectoryTombstones(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

