import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  roleSection,
  RoutineDirectoryError,
  type RoutineDirectory,
  type RoutineDirectorySection,
  type RoutineDirectorySectionProvider,
} from "../application/routine-directory.js";
import { isMissingFileError, readRoutineDirectoryFile } from "./routine-directory-files.js";

function routineDirectoryEntryCount(directory: RoutineDirectory): number {
  return directory.sections.reduce((count, section) => count + section.entries.length, 0);
}

export class RoutineDirectoryProviderStartupError extends Error {
  readonly name = "RoutineDirectoryProviderStartupError";

  constructor(
    readonly code: "directory_read_failed" | "directory_schema_invalid" | RoutineDirectoryError["code"],
    readonly companyId: string,
    cause: unknown,
  ) {
    super(`routine directory for company ${JSON.stringify(companyId)} could not be loaded`, { cause });
  }
}

type LoadedRoutineDirectoryProvider = RoutineDirectorySectionProvider & {
  readonly directories: ReadonlyMap<string, RoutineDirectory>;
};

/**
 * Loads all operator files once. A missing company file is deliberately a soft
 * miss; malformed files fail startup so an operator can run the validate command.
 */
export function loadRoutineDirectoryProvider(
  directory: string | undefined,
  options: { companyIds: readonly string[]; warn?: (message: string) => void } = { companyIds: [] },
): LoadedRoutineDirectoryProvider {
  const directories = new Map<string, RoutineDirectory>();
  if (!directory) return createProvider(directories);

  for (const companyId of options.companyIds) {
    const file = resolveDirectoryFile(directory, companyId);
    try {
      const loadedDirectory = readRoutineDirectoryFile(file, { expectedCompanyId: companyId });
      directories.set(companyId, loadedDirectory);
      options.warn?.(`routine directory loaded: ${JSON.stringify(companyId)}, version ${JSON.stringify(loadedDirectory.version)}, entries ${routineDirectoryEntryCount(loadedDirectory)}`);
    } catch (error) {
      if (isMissingFileError(error)) {
        options.warn?.(`Routine directory file is unavailable for company ${JSON.stringify(companyId)}.`);
        continue;
      }
      if (error instanceof RoutineDirectoryError) {
        throw new RoutineDirectoryProviderStartupError(error.code, companyId, error);
      }
      throw new RoutineDirectoryProviderStartupError("directory_read_failed", companyId, error);
    }
  }
  return createProvider(directories, options.warn);
}

/** Loads every active routine-directory.<companyId>.json file in the operator directory. */
export function loadRoutineDirectoryProviderFromDirectory(
  directory: string | undefined,
  options: { warn?: (message: string) => void } = {},
): LoadedRoutineDirectoryProvider {
  if (!directory) return createProvider(new Map());
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => /^routine-directory\.[^./]+\.json$/u.test(file));
  } catch (error) {
    if (isMissingFileError(error)) {
      options.warn?.("Routine directory directory is unavailable.");
      return createProvider(new Map());
    }
    throw new RoutineDirectoryProviderStartupError("directory_read_failed", "*", error);
  }
  const companyIds = files
    .map((file) => /^routine-directory\.([^./]+)(?:\.[^./]+)?\.json$/u.exec(file)?.[1])
    .filter((companyId): companyId is string => companyId !== undefined);
  return loadRoutineDirectoryProvider(directory, { companyIds: [...new Set(companyIds)], warn: options.warn });
}

function createProvider(
  directories: Map<string, RoutineDirectory>,
  warn?: (message: string) => void,
): LoadedRoutineDirectoryProvider {
  const warnedCompanies = new Set<string>();
  const provider = ((companyId: string, roleId: string): RoutineDirectorySection | undefined => {
    const directory = directories.get(companyId);
    if (!directory) {
      if (!warnedCompanies.has(companyId)) {
        warnedCompanies.add(companyId);
        warn?.(`Routine directory file is unavailable for company ${JSON.stringify(companyId)}.`);
      }
      return undefined;
    }
    if (!directory.sections.some((section) => section.roleId === roleId)) return undefined;
    return roleSection(directory, roleId);
  }) as LoadedRoutineDirectoryProvider;
  Object.defineProperty(provider, "directories", { value: directories });
  return provider;
}

function resolveDirectoryFile(directory: string, companyId: string): string {
  return join(directory, `routine-directory.${companyId}.json`);
}
