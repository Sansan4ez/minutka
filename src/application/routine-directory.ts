import { z } from "zod";
import { quickWinAssignmentSchema } from "./quick-wins.js";
import { routineIdMaxLength } from "../contracts/minutka-activity.js";
import { countUnicodeCodePoints } from "../shared/chat-limits.js";

const routineDirectorySchemaVersion = "minutka-routine-directory/v1" as const;

const provenanceSchema = z.strictObject({
  groupId: z.string().trim().min(1),
  subjectKey: z.string().trim().min(1),
});

const routineEntrySchema = z.strictObject({
  id: z.string().trim().min(1).max(routineIdMaxLength),
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
  version: z.string().regex(/^\d+$/u),
  createdAt: z.iso.datetime().optional(),
  sections: z.array(routineSectionSchema),
});

export type RoutineDirectory = z.infer<typeof routineDirectorySchema>;
export type RoutineDirectoryEntry = RoutineDirectory["sections"][number]["entries"][number];

export type RoutineDirectorySection = {
  version: string;
  entries: Array<Pick<RoutineDirectoryEntry, "id" | "name" | "description" | "examples">>;
};

export const routineDirectorySectionBudget = {
  maximumEntries: 40,
  maximumCharacters: 12_000,
} as const;

export type RoutineDirectoryRoleSectionMeasurement = {
  roleId: string;
  entries: number;
  characters: number;
};

/** Request-local lookup used by the activity transaction boundary. */
export type RoutineDirectorySectionProvider = (companyId: string, roleId: string) => RoutineDirectorySection | undefined;

export type RoutineDirectorySuggestSection = RoutineDirectorySection & {
  entries: Array<Pick<RoutineDirectoryEntry, "id" | "name" | "description" | "examples" | "quickWin" | "methodologistNote">>;
};

export type RoutineDirectoryErrorCode =
  | "directory_scope_mismatch"
  | "directory_version_missing"
  | "directory_version_invalid"
  | "directory_duplicate_id"
  | "directory_unknown_quick_win"
  | "directory_provenance_missing"
  | "directory_reused_id"
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
  version: z.string().regex(/^\d+$/u),
  createdAt: z.iso.datetime().optional(),
  sections: z.array(z.strictObject({
    roleId: z.string().trim().min(1),
    entries: z.array(z.strictObject({
      id: z.string().trim().min(1).max(routineIdMaxLength),
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

export type RoutineDirectoryTombstoneIds = ReadonlySet<string>;

export function loadRoutineDirectoryTombstones(json: unknown): string[] {
  const ids = isRecord(json) && Array.isArray(json.ids) ? json.ids : json;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.trim() === "")) {
    throw new RoutineDirectoryError("directory_schema_invalid", "routine directory tombstones are invalid");
  }
  return [...new Set(ids.map((id) => id.trim()))].sort();
}

export function loadRoutineDirectory(
  json: unknown,
  options: { expectedCompanyId: string; tombstoneIds?: RoutineDirectoryTombstoneIds },
): RoutineDirectory {
  if (isRecord(json) && (!Object.hasOwn(json, "version") || (typeof json.version === "string" && json.version.trim() === ""))) {
    throw new RoutineDirectoryError("directory_version_missing", "routine directory version is required");
  }

  const structure = routineDirectoryStructureSchema.safeParse(json);
  if (!structure.success) {
    if (isRecord(json) && typeof json.version === "string" && !/^\d+$/u.test(json.version.trim())) {
      throw new RoutineDirectoryError("directory_version_invalid", "routine directory version must be a non-negative integer");
    }
    throw new RoutineDirectoryError("directory_schema_invalid", routineDirectorySchemaError(structure.error));
  }

  if (structure.data.companyId !== options.expectedCompanyId) {
    throw new RoutineDirectoryError("directory_scope_mismatch", "routine directory company does not match the expected company");
  }

  const duplicateId = findDuplicateId(structure.data);
  if (duplicateId) {
    throw new RoutineDirectoryError("directory_duplicate_id", `routine directory contains duplicate id ${JSON.stringify(duplicateId)}`);
  }

  for (const section of structure.data.sections) {
    for (const entry of section.entries) {
      if (options.tombstoneIds?.has(entry.id)) {
        throw new RoutineDirectoryError("directory_reused_id", `routine directory reuses tombstoned id ${JSON.stringify(entry.id)}`);
      }
      if (!entry.provenance || entry.provenance.length === 0) {
        throw new RoutineDirectoryError("directory_provenance_missing", `routine directory entry ${JSON.stringify(entry.id)} has no provenance`);
      }
      if (!quickWinAssignmentSchema.safeParse(entry.quickWin).success) {
        throw new RoutineDirectoryError("directory_unknown_quick_win", `routine directory entry ${JSON.stringify(entry.id)} has an unknown quick win`);
      }
    }
  }

  const parsed = routineDirectorySchema.safeParse(structure.data);
  if (!parsed.success) throw new RoutineDirectoryError("directory_schema_invalid", routineDirectorySchemaError(parsed.error));
  return parsed.data;
}

export function compareDirectoryVersions(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function roleSection(directory: RoutineDirectory, roleId: string): RoutineDirectorySection {
  const section = directory.sections.find((candidate) => candidate.roleId === roleId);
  return {
    version: directory.version,
    entries: (section?.entries ?? []).map(({ id, name, description, examples }) => ({ id, name, description, examples })),
  };
}

export function measureRoleSection(directory: RoutineDirectory, roleId: string): RoutineDirectoryRoleSectionMeasurement {
  const section = roleSection(directory, roleId);
  return {
    roleId,
    entries: section.entries.length,
    characters: countUnicodeCodePoints(JSON.stringify(section)),
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

function routineDirectorySchemaError(error: z.ZodError): string {
  return error.issues.some((issue) => issue.code === "too_big" && issue.path.at(-1) === "id")
    ? `routine directory routine id must be at most ${routineIdMaxLength} characters`
    : "routine directory schema is invalid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
