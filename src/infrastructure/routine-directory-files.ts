import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  loadRoutineDirectory,
  loadRoutineDirectoryTombstones,
  RoutineDirectoryError,
  type RoutineDirectory,
} from "../application/routine-directory.js";

export function readRoutineDirectoryFile(
  path: string,
  options: { expectedCompanyId: string; requireWorkCategories?: boolean },
): RoutineDirectory {
  const tombstoneIds = readTombstones(dirname(path), options.expectedCompanyId);
  const json = readJson(path, "routine directory JSON is invalid");
  return loadRoutineDirectory(json, { ...options, tombstoneIds: new Set(tombstoneIds) });
}

export function readTombstones(directory: string, companyId: string): string[] {
  const path = join(directory, `routine-directory.${companyId}.tombstones.json`);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
  try {
    return loadRoutineDirectoryTombstones(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof RoutineDirectoryError) throw error;
    throw new RoutineDirectoryError("directory_schema_invalid", "routine directory tombstones JSON is invalid");
  }
}

export function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readJson(path: string, invalidMessage: string): unknown {
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RoutineDirectoryError("directory_schema_invalid", invalidMessage);
  }
}
