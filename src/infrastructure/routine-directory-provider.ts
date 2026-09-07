import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadRoutineDirectory,
  loadRoutineDirectoryTombstones,
  roleSection,
  RoutineDirectoryError,
  type RoutineDirectory,
  type RoutineDirectorySection,
  type RoutineDirectorySectionProvider,
} from "../application/routine-directory.js";

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
    const tombstones = readTombstones(directory, companyId);
    const file = resolveDirectoryFile(directory, companyId);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        options.warn?.(`Routine directory file is unavailable for company ${JSON.stringify(companyId)}.`);
        continue;
      }
      throw new RoutineDirectoryProviderStartupError("directory_read_failed", companyId, error);
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch (error) {
      throw new RoutineDirectoryProviderStartupError("directory_schema_invalid", companyId, error);
    }
    try {
      directories.set(companyId, loadRoutineDirectory(json, { expectedCompanyId: companyId, tombstoneIds: new Set(tombstones) }));
    } catch (error) {
      if (error instanceof RoutineDirectoryError) {
        throw new RoutineDirectoryProviderStartupError(error.code, companyId, error);
      }
      throw error;
    }
  }
  return createProvider(directories, options.warn);
}

/** Loads every routine-directory.<companyId>.json file in the operator directory. */
export function loadRoutineDirectoryProviderFromDirectory(
  directory: string | undefined,
  options: { warn?: (message: string) => void } = {},
): LoadedRoutineDirectoryProvider {
  if (!directory) return createProvider(new Map());
  let files: string[];
  try {
    files = readdirSync(directory).filter((file) => /^routine-directory\.[^./]+(?:\.[^./]+)?\.json$/u.test(file) && !file.endsWith(".tombstones.json"));
  } catch (error) {
    if (isMissingFile(error)) {
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
  const active = join(directory, `routine-directory.${companyId}.json`);
  try {
    readFileSync(active);
    return active;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const versioned = readdirSync(directory)
    .filter((file) => file.startsWith(`routine-directory.${companyId}.`) && file.endsWith(".json") && !file.endsWith(".tombstones.json"))
    .sort()
    .reverse();
  return join(directory, versioned[0] ?? `routine-directory.${companyId}.json`);
}

function readTombstones(directory: string, companyId: string): string[] {
  try {
    return loadRoutineDirectoryTombstones(JSON.parse(readFileSync(join(directory, `routine-directory.${companyId}.tombstones.json`), "utf8")) as unknown);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw new RoutineDirectoryProviderStartupError("directory_schema_invalid", companyId, error);
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
