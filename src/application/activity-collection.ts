import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  activityCollectionItemSchema,
  collectActivitiesInputSchema,
  type CollectActivitiesInput,
  type CollectActivityInput,
} from "../contracts/minutka-activity.js";
import type {
  ActivityDurationBucket,
  ActivitySystem,
  AutomationCandidateType,
  EnergyStressMarkerType,
  RoutinePatternType,
  TaskCategory,
} from "../domain/insights.js";
import { calendarDateInIanaTimezone } from "../shared/iana-timezone.js";
import { PersistenceOutcomeUnknownError } from "./persistence-error.js";
import { systemClock, type Clock } from "./runtime-primitives.js";

export type ActivityObstacle =
  | { kind: "routine_pattern"; value: RoutinePatternType }
  | { kind: "automation_candidate"; value: AutomationCandidateType }
  | { kind: "energy_stress_marker"; value: EnergyStressMarkerType };

export type PersonalActivityRecord = {
  activityId: string;
  employeeId: string;
  subjectKey: string;
  sourceMessageId?: string;
  companyId: string;
  groupId: string;
  roleId: string;
  taskCategory?: TaskCategory;
  obstacle?: ActivityObstacle;
  durationBucket?: ActivityDurationBucket;
  system?: ActivitySystem;
  activityDate: string;
  recordedAt: string;
};

export type ActivityCollectionStore = {
  /** Persists the single canonical, subject-aware activity record. */
  saveActivity(activity: PersonalActivityRecord): Promise<void>;
  /** Optional read-back used only to reconcile an unknown non-idempotent write outcome. */
  getActivityById?(activityId: string): Promise<PersonalActivityRecord | undefined>;
};

const collectActivityCommandSchema = z.strictObject({
  employeeId: z.string().trim().min(1),
  subjectKey: z.string().trim().min(1),
  sourceMessageId: z.string().trim().min(1).optional(),
  companyId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  roleId: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
  activity: activityCollectionItemSchema,
});

const collectActivitiesCommandSchema = collectActivityCommandSchema.omit({ activity: true }).extend({
  activities: collectActivitiesInputSchema.shape.activities,
});

export type CollectActivityCommand = z.input<typeof collectActivityCommandSchema>;
export type CollectActivitiesCommand = z.input<typeof collectActivitiesCommandSchema>;
export type CollectActivitiesResult =
  | { status: "completed"; savedCount: number; activityIds: string[] }
  | { status: "failed"; savedCount: 0; activityIds: []; error: unknown }
  | { status: "partial"; savedCount: number; activityIds: string[]; error: unknown };

/** Typed application boundary used by the agent-facing collection action. */
export class CollectActivityService {
  constructor(
    private readonly store: ActivityCollectionStore,
    private readonly clock: Clock = systemClock,
    private readonly activityId: () => string = () => `activity_${randomUUID()}`,
  ) {}

  async collect(command: CollectActivityCommand): Promise<{ activityId: string }> {
    const input = collectActivityCommandSchema.parse(command);
    const obstacle = activityObstacle(input.activity);
    const recordedAt = this.clock.now();
    const activityId = this.activityId();

    const activity: PersonalActivityRecord = {
      activityId,
      employeeId: input.employeeId,
      subjectKey: input.subjectKey,
      ...(input.sourceMessageId === undefined ? {} : { sourceMessageId: input.sourceMessageId }),
      companyId: input.companyId,
      groupId: input.groupId,
      roleId: input.roleId,
      ...(input.activity.taskCategory === undefined ? {} : { taskCategory: input.activity.taskCategory }),
      ...(obstacle === undefined ? {} : { obstacle }),
      activityDate: calendarDateInIanaTimezone(recordedAt, input.timezone),
      recordedAt,
    };
    if (input.activity.durationBucket !== undefined) activity.durationBucket = input.activity.durationBucket;
    if (input.activity.system !== undefined) activity.system = input.activity.system;

    try {
      await this.store.saveActivity(activity);
    } catch (error) {
      if (!(error instanceof PersistenceOutcomeUnknownError) || !this.store.getActivityById) throw error;
      const recovered = await this.store.getActivityById(activityId).catch(() => undefined);
      if (!recovered || !samePersonalActivity(recovered, activity)) throw error;
    }

    return { activityId };
  }

  /**
   * Validates the full batch before the first write, then preserves the existing
   * one-record-per-activity persistence path in input order.
   */
  async collectBatch(command: CollectActivitiesCommand): Promise<CollectActivitiesResult> {
    const { activities, ...scope } = collectActivitiesCommandSchema.parse(command);
    const activityIds: string[] = [];

    for (const activity of activities) {
      try {
        const result = await this.collect({ ...scope, activity });
        activityIds.push(result.activityId);
      } catch (error) {
        if (error instanceof PersistenceOutcomeUnknownError) throw error;
        return activityIds.length === 0
          ? { status: "failed", savedCount: 0, activityIds: [], error }
          : { status: "partial", savedCount: activityIds.length, activityIds, error };
      }
    }

    return { status: "completed", savedCount: activityIds.length, activityIds };
  }

  /** Agent-facing callback: the authenticated tenant scope is bound outside the model input. */
  bind(scope: Omit<z.infer<typeof collectActivitiesCommandSchema>, "activities">): (input: CollectActivitiesInput) => Promise<CollectActivitiesResult> {
    return ({ activities }) => this.collectBatch({ ...scope, activities });
  }
}

/** Unknown commit recovery succeeds only when read-back proves the exact intended record. */
function samePersonalActivity(left: PersonalActivityRecord, right: PersonalActivityRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Keeps one obstacle per stored activity. The tool asks the model for at most
 * one of the three fields; when it sends more, this fixed order decides which
 * classification is recorded, so a sloppy call still stores the activity.
 */
function activityObstacle(activity: CollectActivityInput): ActivityObstacle | undefined {
  if (activity.routinePattern !== undefined) {
    return { kind: "routine_pattern", value: activity.routinePattern };
  }
  if (activity.automationCandidate !== undefined) {
    return { kind: "automation_candidate", value: activity.automationCandidate };
  }
  if (activity.energyStressMarker !== undefined) {
    return { kind: "energy_stress_marker", value: activity.energyStressMarker };
  }
  return undefined;
}
