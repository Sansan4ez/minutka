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
  InsightKind,
  RoutinePatternType,
  TaskCategory,
} from "../domain/insights.js";
import { systemClock, type Clock } from "./runtime-primitives.js";

export type ActivityInsightValue =
  | TaskCategory
  | RoutinePatternType
  | AutomationCandidateType
  | EnergyStressMarkerType;

export type PersonalActivityRecord = {
  activityId: string;
  employeeId: string;
  companyId: string;
  groupId: string;
  roleId: string;
  kind?: InsightKind;
  value?: ActivityInsightValue;
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
  kind?: InsightKind;
  value?: ActivityInsightValue;
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
    const classification = activityClassification(input.activity);
    const recordedAt = this.clock.now();
    const activityId = this.activityId();

    const personal: PersonalActivityRecord = {
      activityId,
      employeeId: input.employeeId,
      companyId: input.companyId,
      groupId: input.groupId,
      roleId: input.roleId,
      ...classification,
      recordedAt,
    };
    const anonymized: AnonymizedActivityRecord = {
      companyId: input.companyId,
      groupId: input.groupId,
      roleId: input.roleId,
      ...classification,
      date: calendarDate(recordedAt),
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

function activityClassification(activity: CollectActivityInput): {
  kind?: InsightKind;
  value?: ActivityInsightValue;
} {
  const classifications: Array<{ kind: InsightKind; value: ActivityInsightValue }> = [];
  if (activity.taskCategory !== undefined) {
    classifications.push({ kind: "task_category", value: activity.taskCategory });
  }
  if (activity.routinePattern !== undefined) {
    classifications.push({ kind: "routine_pattern", value: activity.routinePattern });
  }
  if (activity.automationCandidate !== undefined) {
    classifications.push({ kind: "automation_candidate", value: activity.automationCandidate });
  }
  if (activity.energyStressMarker !== undefined) {
    classifications.push({ kind: "energy_stress_marker", value: activity.energyStressMarker });
  }
  return classifications[0] ?? {};
}

function calendarDate(instant: string): string {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.valueOf())) throw new Error("clock returned an invalid instant");
  return parsed.toISOString().slice(0, 10);
}
