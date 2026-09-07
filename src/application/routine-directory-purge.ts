import { dirname, join } from "node:path";
import type { RoutineDirectory, RoutineDirectoryEntry } from "./routine-directory.js";

export type RoutineDirectoryFile = {
  path: string;
  directory: RoutineDirectory;
};

export type RoutineDirectoryPurgeScope =
  | "company"
  | { groupId: string }
  | { groupId: string; subjectKey: string };

export type RoutineDirectorySurvivingVersion = RoutineDirectoryFile;

export type RoutineDirectoryPurgePlan = {
  affectedEntryIds: string[];
  filesToDelete: string[];
  survivingVersion?: RoutineDirectorySurvivingVersion;
};

/**
 * Plans a purge without touching the filesystem. A directory entry is removed
 * as a whole when any provenance pair belongs to the requested scope; removing
 * only the matching pair would leave evidence from the deleted subject in the
 * derived artifact.
 */
export function planDirectoryPurge(input: {
  files: readonly RoutineDirectoryFile[];
  scope: RoutineDirectoryPurgeScope;
}): RoutineDirectoryPurgePlan {
  const files = [...input.files].sort(compareFiles);
  const affectedEntryIds = new Set<string>();
  const scope = input.scope;

  if (scope === "company") {
    for (const file of files) {
      for (const entry of entries(file.directory)) affectedEntryIds.add(entry.id);
    }
    return {
      affectedEntryIds: [...affectedEntryIds].sort(),
      filesToDelete: files.map(({ path }) => path).sort(),
    };
  }

  for (const file of files) {
    for (const entry of entries(file.directory)) {
      if (entry.provenance.some((provenance) => provenanceMatches(provenance, scope))) {
        affectedEntryIds.add(entry.id);
      }
    }
  }

  const filesToDelete = files
    .filter((file) => entries(file.directory).some(({ id }) => affectedEntryIds.has(id)))
    .map(({ path }) => path)
    .sort();
  const current = files.at(-1);
  const currentHasAffectedEntries = current !== undefined
    && entries(current.directory).some(({ id }) => affectedEntryIds.has(id));

  if (!current || !currentHasAffectedEntries) {
    return { affectedEntryIds: [...affectedEntryIds].sort(), filesToDelete };
  }

  const survivingEntries = entries(current.directory).filter(({ id }) => !affectedEntryIds.has(id));
  if (survivingEntries.length === 0) {
    return { affectedEntryIds: [...affectedEntryIds].sort(), filesToDelete };
  }

  const version = nextDirectoryVersion(current.directory.version, new Set(files.map(({ directory }) => directory.version)));
  const survivingDirectory: RoutineDirectory = {
    ...current.directory,
    version,
    sections: current.directory.sections
      .map((section) => ({
        ...section,
        entries: section.entries.filter(({ id }) => !affectedEntryIds.has(id)),
      }))
      .filter(({ entries: sectionEntries }) => sectionEntries.length > 0),
  };

  return {
    affectedEntryIds: [...affectedEntryIds].sort(),
    filesToDelete,
    survivingVersion: {
      path: survivingVersionPath(current.path, current.directory.companyId, version),
      directory: survivingDirectory,
    },
  };
}

function entries(directory: RoutineDirectory): RoutineDirectoryEntry[] {
  return directory.sections.flatMap(({ entries: sectionEntries }) => sectionEntries);
}

function provenanceMatches(
  provenance: RoutineDirectoryEntry["provenance"][number],
  scope: Exclude<RoutineDirectoryPurgeScope, "company">,
): boolean {
  if (scope.groupId !== provenance.groupId) return false;
  return "subjectKey" in scope ? scope.subjectKey === provenance.subjectKey : true;
}

function compareFiles(left: RoutineDirectoryFile, right: RoutineDirectoryFile): number {
  const versionOrder = left.directory.version.localeCompare(right.directory.version);
  return versionOrder || left.path.localeCompare(right.path);
}

function nextDirectoryVersion(current: string, existing: ReadonlySet<string>): string {
  const match = /^(.*?)(\d+)$/u.exec(current);
  let candidate = match ? `${match[1]}${Number(match[2]) + 1}` : `${current}-purged`;
  while (existing.has(candidate)) candidate = `${candidate}-1`;
  return candidate;
}

function survivingVersionPath(currentPath: string, companyId: string, version: string): string {
  return join(dirname(currentPath), `routine-directory.${companyId}.${version}.json`);
}
