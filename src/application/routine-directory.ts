import { z } from "zod";
import { quickWinAssignmentSchema } from "./quick-wins.js";

const routineDirectorySchemaVersion = "minutka-routine-directory/v1" as const;

const provenanceSchema = z.strictObject({
  groupId: z.string().trim().min(1),
  subjectKey: z.string().trim().min(1),
});

const routineEntrySchema = z.strictObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().min(1),
  examples: z.array(z.string().trim().min(1)).max(10),
  quickWin: quickWinAssignmentSchema,
  methodologistNote: z.string().trim().min(1).optional(),
  provenance: z.array(provenanceSchema).min(1),
});

const routineSectionSchema = z.strictObject({
  roleId: z.string().trim().min(1),
  entries: z.array(routineEntrySchema),
});

export const routineDirectorySchema = z.strictObject({
  schemaVersion: z.literal(routineDirectorySchemaVersion),
  companyId: z.string().trim().min(1),
  version: z.string().trim().min(1),
  createdAt: z.iso.datetime().optional(),
  sections: z.array(routineSectionSchema),
});

export type RoutineDirectory = z.infer<typeof routineDirectorySchema>;
export type RoutineDirectoryEntry = RoutineDirectory["sections"][number]["entries"][number];

export type RoutineDirectorySection = {
  version: string;
  entries: Array<Pick<RoutineDirectoryEntry, "id" | "name" | "description" | "examples">>;
};

export type RoutineDirectorySuggestSection = RoutineDirectorySection & {
  entries: Array<Pick<RoutineDirectoryEntry, "id" | "name" | "description" | "examples" | "quickWin" | "methodologistNote">>;
};

export type RoutineDirectoryErrorCode =
  | "directory_scope_mismatch"
  | "directory_version_missing"
  | "directory_duplicate_id"
  | "directory_unknown_quick_win"
  | "directory_provenance_missing"
  | "directory_schema_invalid";

export class RoutineDirectoryError extends Error {
  readonly name = "RoutineDirectoryError";

  constructor(
    readonly code: RoutineDirectoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const routineDirectoryStructureSchema = z.strictObject({
  schemaVersion: z.literal(routineDirectorySchemaVersion),
  companyId: z.string().trim().min(1),
  version: z.string().trim().min(1),
  createdAt: z.iso.datetime().optional(),
  sections: z.array(z.strictObject({
    roleId: z.string().trim().min(1),
    entries: z.array(z.strictObject({
      id: z.string().trim().min(1),
      name: z.string().trim().min(3).max(80),
      description: z.string().trim().min(1),
      examples: z.array(z.string().trim().min(1)).max(10),
      quickWin: z.string().trim().min(1),
      methodologistNote: z.string().trim().min(1).optional(),
      provenance: z.array(provenanceSchema).optional(),
    })),
  })),
});

type RoutineDirectoryStructure = z.infer<typeof routineDirectoryStructureSchema>;

export function loadRoutineDirectory(
  json: unknown,
  options: { expectedCompanyId: string },
): RoutineDirectory {
  if (isRecord(json) && (!Object.hasOwn(json, "version") || (typeof json.version === "string" && json.version.trim() === ""))) {
    throw new RoutineDirectoryError("directory_version_missing", "routine directory version is required");
  }

  const structure = routineDirectoryStructureSchema.safeParse(json);
  if (!structure.success) throw new RoutineDirectoryError("directory_schema_invalid", "routine directory schema is invalid");

  if (structure.data.companyId !== options.expectedCompanyId) {
    throw new RoutineDirectoryError("directory_scope_mismatch", "routine directory company does not match the expected company");
  }

  const duplicateId = findDuplicateId(structure.data);
  if (duplicateId) {
    throw new RoutineDirectoryError("directory_duplicate_id", `routine directory contains duplicate id ${JSON.stringify(duplicateId)}`);
  }

  for (const section of structure.data.sections) {
    for (const entry of section.entries) {
      if (!entry.provenance || entry.provenance.length === 0) {
        throw new RoutineDirectoryError("directory_provenance_missing", `routine directory entry ${JSON.stringify(entry.id)} has no provenance`);
      }
      if (!quickWinAssignmentSchema.safeParse(entry.quickWin).success) {
        throw new RoutineDirectoryError("directory_unknown_quick_win", `routine directory entry ${JSON.stringify(entry.id)} has an unknown quick win`);
      }
    }
  }

  const parsed = routineDirectorySchema.safeParse(structure.data);
  if (!parsed.success) throw new RoutineDirectoryError("directory_schema_invalid", "routine directory schema is invalid");
  return parsed.data;
}

export function roleSection(directory: RoutineDirectory, roleId: string): RoutineDirectorySection {
  const section = directory.sections.find((candidate) => candidate.roleId === roleId);
  return {
    version: directory.version,
    entries: (section?.entries ?? []).map(({ id, name, description, examples }) => ({ id, name, description, examples })),
  };
}

export function roleSectionForSuggest(directory: RoutineDirectory, roleId: string): RoutineDirectorySuggestSection {
  const section = directory.sections.find((candidate) => candidate.roleId === roleId);
  return {
    version: directory.version,
    entries: (section?.entries ?? []).map(({ id, name, description, examples, quickWin, methodologistNote }) => ({
      id,
      name,
      description,
      examples,
      quickWin,
      ...(methodologistNote ? { methodologistNote } : {}),
    })),
  };
}

export function routineDirectoryCounts(directory: RoutineDirectory): {
  roles: number;
  entries: number;
  quickWins: number;
  deepDive: number;
} {
  const entries = directory.sections.flatMap(({ entries: sectionEntries }) => sectionEntries);
  return {
    roles: directory.sections.length,
    entries: entries.length,
    quickWins: entries.filter(({ quickWin }) => quickWin !== "deep_dive").length,
    deepDive: entries.filter(({ quickWin }) => quickWin === "deep_dive").length,
  };
}

function findDuplicateId(directory: RoutineDirectoryStructure): string | undefined {
  const ids = new Set<string>();
  for (const section of directory.sections) {
    for (const entry of section.entries) {
      if (ids.has(entry.id)) return entry.id;
      ids.add(entry.id);
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
