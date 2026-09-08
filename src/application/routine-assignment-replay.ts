import { z } from "zod";

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

/** Applies one reviewed, exact activity-to-directory assignment pack atomically. */
export class RoutineAssignmentReplayService {
  constructor(private readonly store: RoutineAssignmentReplayStore) {}

  async replay(rawInput: unknown): Promise<RoutineAssignmentReplayResult> {
    return this.store.replay(routineAssignmentReplayInputSchema.parse(rawInput));
  }
}
