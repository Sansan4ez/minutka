import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  collectActivityInputSchema,
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
import { systemClock, type Clock } from "./runtime-primitives.js";

export type ActivityObstacle =
  | { kind: "routine_pattern"; value: RoutinePatternType }
  | { kind: "automation_candidate"; value: AutomationCandidateType }
  | { kind: "energy_stress_marker"; value: EnergyStressMarkerType };

export type PersonalActivityRecord = {
  activityId: string;
  employeeId: string;
  companyId: string;
  groupId: string;
  roleId: string;
  taskCategory?: TaskCategory;
  obstacle?: ActivityObstacle;
  durationBucket?: ActivityDurationBucket;
  system?: ActivitySystem;
  recordedAt: string;
};

/**
 * Deliberately has no owner identifier, private-record identifier, free text,
 * or timestamp. Its only time dimension is a calendar date.
 */
export type AnonymizedActivityRecord = {
  companyId: string;
  groupId: string;
  roleId: string;
  taskCategory?: TaskCategory;
  obstacle?: ActivityObstacle;
  durationBucket?: ActivityDurationBucket;
  system?: ActivitySystem;
  date: string;
};

export type ActivityCollectionStore = {
  /** Persists both records as one atomic unit. */
  saveActivityPair(input: {
    personal: PersonalActivityRecord;
    anonymized: AnonymizedActivityRecord;
  }): Promise<void>;
};

const collectActivityCommandSchema = z.strictObject({
  employeeId: z.string().trim().min(1),
  companyId: z.string().trim().min(1),
  groupId: z.string().trim().min(1),
  roleId: z.string().trim().min(1),
  timezone: z.string().trim().min(1),
  activity: collectActivityInputSchema,
});

export type CollectActivityCommand = z.input<typeof collectActivityCommandSchema>;

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

    const personal: PersonalActivityRecord = {
      activityId,
      employeeId: input.employeeId,
      companyId: input.companyId,
      groupId: input.groupId,
      roleId: input.roleId,
      ...(input.activity.taskCategory === undefined ? {} : { taskCategory: input.activity.taskCategory }),
      ...(obstacle === undefined ? {} : { obstacle }),
      recordedAt,
    };
    const anonymized: AnonymizedActivityRecord = {
      companyId: input.companyId,
      groupId: input.groupId,
      roleId: input.roleId,
      ...(input.activity.taskCategory === undefined ? {} : { taskCategory: input.activity.taskCategory }),
      ...(obstacle === undefined ? {} : { obstacle }),
      date: calendarDateInIanaTimezone(recordedAt, input.timezone),
    };
    if (input.activity.durationBucket !== undefined) {
      personal.durationBucket = input.activity.durationBucket;
      anonymized.durationBucket = input.activity.durationBucket;
    }
    if (input.activity.system !== undefined) {
      personal.system = input.activity.system;
      anonymized.system = input.activity.system;
    }

    await this.store.saveActivityPair({ personal, anonymized });

    return { activityId };
  }

  /** Agent-facing callback: the authenticated tenant scope is bound outside the model input. */
  bind(scope: Omit<z.infer<typeof collectActivityCommandSchema>, "activity">): (activity: CollectActivityInput) => Promise<{ activityId: string }> {
    return (activity) => this.collect({ ...scope, activity });
  }
}

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
