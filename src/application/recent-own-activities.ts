import type { PersonalActivityRecord } from "./activity-collection.js";
import { systemClock, type Clock } from "./runtime-primitives.js";

/** Deliberately short correction lookup: no global or semantic activity search. */
export const recentOwnActivitiesWindowHours = 72;
/** Small enough for an unambiguous local choice inside one agent turn. */
export const recentOwnActivitiesMaximumItems = 5;

export type RecentOwnActivityWindow = {
  employeeId: string;
  companyId: string;
  groupId: string;
  recordedAfter: string;
  recordedBefore: string;
  limit: number;
};

export type RecentOwnActivityReadStore = {
  /** Returns candidates only from the authenticated employee and tenant tuple. */
  listRecentOwnActivities(window: RecentOwnActivityWindow): Promise<PersonalActivityRecord[]>;
};

export type RecentOwnActivity = {
  /** Opaque application handle; it is not an employee, subject, or tenant id. */
  handle: string;
  /** Initial immutable rows are revision 1; the correction contour will advance it. */
  revision: number;
  taskCategory?: PersonalActivityRecord["taskCategory"];
  routinePattern?: PersonalActivityRecord["routinePattern"];
  automationCandidate?: PersonalActivityRecord["automationCandidate"];
  energyStressMarker?: PersonalActivityRecord["energyStressMarker"];
  durationBucket?: PersonalActivityRecord["durationBucket"];
  system?: PersonalActivityRecord["system"];
  activityDate: string;
  recordedAt: string;
};

export type RecentOwnActivitiesResult = { activities: RecentOwnActivity[] };

/** Owner-bound bounded read used only to resolve an explicit recent correction. */
export class RecentOwnActivitiesService {
  constructor(
    private readonly store: RecentOwnActivityReadStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async read(input: { employeeId: string; companyId: string; groupId: string }): Promise<RecentOwnActivitiesResult> {
    const employeeId = required(input.employeeId, "employeeId");
    const companyId = required(input.companyId, "companyId");
    const groupId = required(input.groupId, "groupId");
    const recordedBefore = validInstant(this.clock.now(), "clock instant");
    const recordedAfter = new Date(Date.parse(recordedBefore) - recentOwnActivitiesWindowHours * 60 * 60 * 1_000).toISOString();
    const window = {
      employeeId,
      companyId,
      groupId,
      recordedAfter,
      recordedBefore,
      limit: recentOwnActivitiesMaximumItems,
    };
    const listed = await this.store.listRecentOwnActivities(window);
    const activities = listed
      .filter((activity) => activity.employeeId === employeeId
        && activity.companyId === companyId
        && activity.groupId === groupId
        && activity.recordedAt >= recordedAfter
        && activity.recordedAt <= recordedBefore)
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt)
        || right.activityId.localeCompare(left.activityId))
      .slice(0, recentOwnActivitiesMaximumItems)
      .map(toRecentOwnActivity);
    return { activities };
  }

  /** Agent-facing callback with all identity and window controls outside model input. */
  bind(scope: { employeeId: string; companyId: string; groupId: string }): () => Promise<RecentOwnActivitiesResult> {
    return () => this.read(scope);
  }
}

function toRecentOwnActivity(activity: PersonalActivityRecord): RecentOwnActivity {
  return {
    handle: activity.activityId,
    revision: 1,
    ...(activity.taskCategory === undefined ? {} : { taskCategory: activity.taskCategory }),
    ...(activity.routinePattern === undefined ? {} : { routinePattern: activity.routinePattern }),
    ...(activity.automationCandidate === undefined ? {} : { automationCandidate: activity.automationCandidate }),
    ...(activity.energyStressMarker === undefined ? {} : { energyStressMarker: activity.energyStressMarker }),
    ...(activity.durationBucket === undefined ? {} : { durationBucket: activity.durationBucket }),
    ...(activity.system === undefined ? {} : { system: activity.system }),
    activityDate: activity.activityDate,
    recordedAt: activity.recordedAt,
  };
}

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function validInstant(value: string, name: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`${name} must be a valid timestamp`);
  return date.toISOString();
}
