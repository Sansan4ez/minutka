import { z } from "zod";
import { activityCollectionItemSchema } from "../contracts/minutka-activity.js";
import { PersistenceError } from "./persistence-error.js";
import { recentOwnActivitiesWindowHours } from "./recent-own-activities.js";
import { systemClock, type Clock } from "./runtime-primitives.js";
import type { PersonalActivityRecord } from "./activity-collection.js";

export const activityCorrectionModes = ["patch", "replace"] as const;
export type ActivityCorrectionMode = typeof activityCorrectionModes[number];
export const activityStatuses = ["active", "superseded"] as const;
export type ActivityStatus = typeof activityStatuses[number];
export const activityRevisionOperations = ["created", "corrected", "superseded"] as const;
export type ActivityRevisionOperation = typeof activityRevisionOperations[number];

export type ActivityRevisionRecord = {
  revision: number;
  operation: ActivityRevisionOperation;
  sourceMessageId?: string;
  taskCategory?: PersonalActivityRecord["taskCategory"];
  routinePattern?: PersonalActivityRecord["routinePattern"];
  automationCandidate?: PersonalActivityRecord["automationCandidate"];
  energyStressMarker?: PersonalActivityRecord["energyStressMarker"];
  durationBucket?: PersonalActivityRecord["durationBucket"];
  system?: PersonalActivityRecord["system"];
  status: ActivityStatus;
  supersededByActivityId?: string;
  changedAt: string;
};

export const activityCorrectionPatchSchema = z.strictObject({
  ...activityCollectionItemSchema.shape,
});

export const correctRecentActivityInputSchema = z.strictObject({
  handle: z.string().trim().min(1),
  expectedRevision: z.number().int().min(1),
  mode: z.enum(activityCorrectionModes),
  correction: activityCorrectionPatchSchema,
});

export const supersedeRecentActivityInputSchema = z.strictObject({
  handle: z.string().trim().min(1),
  expectedRevision: z.number().int().min(1),
  replacementHandle: z.string().trim().min(1),
  replacementExpectedRevision: z.number().int().min(1),
});

export type CorrectRecentActivityInput = z.infer<typeof correctRecentActivityInputSchema>;
export type SupersedeRecentActivityInput = z.infer<typeof supersedeRecentActivityInputSchema>;

export type ActivityMutationScope = {
  employeeId: string;
  companyId: string;
  groupId: string;
  sourceMessageId: string;
};

export type ActivityCorrectionCommand = ActivityMutationScope & Omit<CorrectRecentActivityInput, "correction"> & CorrectRecentActivityInput["correction"] & {
  recordedAfter: string;
  recordedBefore: string;
  changedAt: string;
};

export type ActivitySupersessionCommand = ActivityMutationScope & SupersedeRecentActivityInput & {
  recordedAfter: string;
  recordedBefore: string;
  changedAt: string;
};

export type ActivityMutationStore = {
  correctRecentActivity(command: ActivityCorrectionCommand): Promise<PersonalActivityRecord>;
  supersedeRecentActivity(command: ActivitySupersessionCommand): Promise<PersonalActivityRecord>;
};

export type ActivityMutationResult = { status: "completed"; handle: string; revision: number };

/** Exact-handle, owner-bound local repair. It never searches or merges activities semantically. */
export class ActivityCorrectionService {
  constructor(
    private readonly store: ActivityMutationStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async correct(scope: ActivityMutationScope, input: CorrectRecentActivityInput): Promise<ActivityMutationResult> {
    const parsedScope = mutationScopeSchema.parse(scope);
    const parsed = correctRecentActivityInputSchema.parse(input);
    const window = correctionWindow(this.clock.now());
    const { correction, ...selection } = parsed;
    const activity = await this.store.correctRecentActivity({ ...parsedScope, ...selection, ...correction, ...window });
    assertMutationResult(activity, parsedScope, parsed.handle);
    return { status: "completed", handle: activity.activityId, revision: activity.revision ?? 1 };
  }

  async supersede(scope: ActivityMutationScope, input: SupersedeRecentActivityInput): Promise<ActivityMutationResult> {
    const parsedScope = mutationScopeSchema.parse(scope);
    const parsed = supersedeRecentActivityInputSchema.parse(input);
    if (parsed.handle === parsed.replacementHandle) throw new PersistenceError("persistence_conflict");
    const window = correctionWindow(this.clock.now());
    const activity = await this.store.supersedeRecentActivity({ ...parsedScope, ...parsed, ...window });
    assertMutationResult(activity, parsedScope, parsed.handle);
    if (activity.status !== "superseded" || activity.supersededByActivityId !== parsed.replacementHandle) {
      throw new PersistenceError("persistence_conflict");
    }
    return { status: "completed", handle: activity.activityId, revision: activity.revision ?? 1 };
  }
}

const mutationScopeSchema = z.strictObject({
  employeeId: z.string().trim().min(1),
  companyId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  sourceMessageId: z.string().trim().min(1),
});

function correctionWindow(now: string) {
  const recordedBefore = validInstant(now);
  return {
    changedAt: recordedBefore,
    recordedBefore,
    recordedAfter: new Date(Date.parse(recordedBefore) - recentOwnActivitiesWindowHours * 60 * 60 * 1_000).toISOString(),
  };
}

function validInstant(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error("clock instant must be a valid timestamp");
  return parsed.toISOString();
}

function assertMutationResult(activity: PersonalActivityRecord, scope: ActivityMutationScope, handle: string): void {
  if (activity.activityId !== handle
    || activity.employeeId !== scope.employeeId
    || activity.companyId !== scope.companyId
    || activity.groupId !== scope.groupId) {
    throw new PersistenceError("persistence_conflict");
  }
}
