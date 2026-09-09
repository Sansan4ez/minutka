import { z } from "zod";
import type { RoutineDirectory } from "./routine-directory.js";

const nonEmptyText = z.string().trim().min(1);

export const routineAssignmentReplayInputSchema = z.strictObject({
  schemaVersion: z.literal("minutka-routine-assignment-replay/v1"),
  companyId: nonEmptyText,
  groupId: nonEmptyText,
  source: z.strictObject({
    corpusExportedAt: z.iso.datetime(),
    directoryVersion: z.string().regex(/^\d+$/u),
    reviewedBy: nonEmptyText,
  }),
  assignments: z.array(z.strictObject({
    activityId: nonEmptyText,
    roleId: nonEmptyText,
    routineId: nonEmptyText,
    routineLabel: z.string().trim().min(3).max(80),
  })).min(1),
}).superRefine((input, context) => {
  const ids = new Set<string>();
  input.assignments.forEach((assignment, index) => {
    if (ids.has(assignment.activityId)) {
      context.addIssue({ code: "custom", path: ["assignments", index, "activityId"], message: "duplicate activityId" });
    }
    ids.add(assignment.activityId);
  });
});

export type RoutineAssignmentReplayInput = z.infer<typeof routineAssignmentReplayInputSchema>;
export type RoutineAssignmentReplayResult = {
  status: "applied" | "already_applied";
  assignments: number;
  applied: number;
  alreadyApplied: number;
};

export type RoutineAssignmentReplayStore = {
  replay(input: RoutineAssignmentReplayInput): Promise<RoutineAssignmentReplayResult>;
};

export type RoutineAssignmentReplayErrorCode =
  | "directory_scope_mismatch"
  | "directory_version_mismatch"
  | "directory_role_missing"
  | "directory_routine_missing";

export class RoutineAssignmentReplayError extends Error {
  readonly name = "RoutineAssignmentReplayError";

  constructor(readonly code: RoutineAssignmentReplayErrorCode, message: string) {
    super(message);
  }
}

/** Applies one reviewed, exact activity-to-directory assignment pack atomically. */
export class RoutineAssignmentReplayService {
  constructor(private readonly store: RoutineAssignmentReplayStore) {}

  async replay(rawInput: unknown, directory: RoutineDirectory): Promise<RoutineAssignmentReplayResult> {
    const input = routineAssignmentReplayInputSchema.parse(rawInput);
    validateDirectory(input, directory);
    return this.store.replay(input);
  }
}

function validateDirectory(input: RoutineAssignmentReplayInput, directory: RoutineDirectory): void {
  if (directory.companyId !== input.companyId) {
    throw new RoutineAssignmentReplayError("directory_scope_mismatch", "routine directory company does not match replay company");
  }
  if (directory.version !== input.source.directoryVersion) {
    throw new RoutineAssignmentReplayError(
      "directory_version_mismatch",
      `routine directory version ${JSON.stringify(directory.version)} does not match replay version ${JSON.stringify(input.source.directoryVersion)}`,
    );
  }
  for (const assignment of input.assignments) {
    const section = directory.sections.find(({ roleId }) => roleId === assignment.roleId);
    if (!section) {
      throw new RoutineAssignmentReplayError(
        "directory_role_missing",
        `routine directory has no section for role ${JSON.stringify(assignment.roleId)}`,
      );
    }
    if (!section.entries.some(({ id }) => id === assignment.routineId)) {
      throw new RoutineAssignmentReplayError(
        "directory_routine_missing",
        `routine ${JSON.stringify(assignment.routineId)} is not in role ${JSON.stringify(assignment.roleId)}`,
      );
    }
  }
}
