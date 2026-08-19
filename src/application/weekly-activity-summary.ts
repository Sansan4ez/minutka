import type { PersonalActivityRecord } from "./activity-collection.js";
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

/** Inclusive local-date window of the weekly personal checkpoint. */
export const weeklySummaryWindowDays = 7;

/**
 * Below this the summary reports the window as thin instead of naming a
 * pattern. One busy day is not a week, and a single activity is not a routine.
 */
export const weeklySummarySufficiency = { activities: 3, activeDates: 2 } as const;

/**
 * The narrowest projection a personal weekly summary needs. Subject keys,
 * activity ids, and message links stay out of it: the summary describes the
 * employee's own week and never carries research identifiers toward the model.
 */
export type OwnActivityFacet = Pick<
  PersonalActivityRecord,
  "employeeId" | "taskCategory" | "obstacle" | "durationBucket" | "system" | "activityDate"
>;

export type OwnActivityWindow = { employeeId: string; fromDate: string; toDate: string };

export type OwnActivityReadStore = {
  /** Returns one employee's own activities inside an inclusive local-date window. */
  listOwnActivities(window: OwnActivityWindow): Promise<OwnActivityFacet[]>;
};

export type WeeklyActivityTally<Value extends string> = { value: Value; count: number };

export type WeeklyActivitySummary = {
  fromDate: string;
  toDate: string;
  activityCount: number;
  activeDates: number;
  /** False when the window is too thin to name a pattern honestly. */
  sufficientData: boolean;
  taskCategories: WeeklyActivityTally<TaskCategory>[];
  routinePatterns: WeeklyActivityTally<RoutinePatternType>[];
  automationCandidates: WeeklyActivityTally<AutomationCandidateType>[];
  energyStressMarkers: WeeklyActivityTally<EnergyStressMarkerType>[];
  durationBuckets: WeeklyActivityTally<ActivityDurationBucket>[];
  systems: WeeklyActivityTally<ActivitySystem>[];
};

/**
 * Typed owner-scoped read behind the weekly checkpoint. Counting happens here
 * rather than in the model, so the summary can only name what the employee
 * actually reported.
 */
export class WeeklyActivitySummaryService {
  constructor(
    private readonly store: OwnActivityReadStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async summarize(input: { employeeId: string; timezone: string }): Promise<WeeklyActivitySummary> {
    const employeeId = input.employeeId.trim();
    if (!employeeId) throw new Error("employeeId is required");
    const toDate = calendarDateInIanaTimezone(this.clock.now(), input.timezone);
    const fromDate = shiftCalendarDate(toDate, 1 - weeklySummaryWindowDays);
    const listed = await this.store.listOwnActivities({ employeeId, fromDate, toDate });
    // Owner isolation does not depend on the adapter: another employee's row or
    // an out-of-window row can never reach the summary.
    const activities = listed.filter((activity) =>
      activity.employeeId === employeeId && activity.activityDate >= fromDate && activity.activityDate <= toDate);
    const activeDates = new Set(activities.map((activity) => activity.activityDate)).size;

    return {
      fromDate,
      toDate,
      activityCount: activities.length,
      activeDates,
      sufficientData: activities.length >= weeklySummarySufficiency.activities
        && activeDates >= weeklySummarySufficiency.activeDates,
      taskCategories: tally(activities.map((activity) => activity.taskCategory)),
      routinePatterns: tally(activities.flatMap((activity) =>
        activity.obstacle?.kind === "routine_pattern" ? [activity.obstacle.value] : [])),
      automationCandidates: tally(activities.flatMap((activity) =>
        activity.obstacle?.kind === "automation_candidate" ? [activity.obstacle.value] : [])),
      energyStressMarkers: tally(activities.flatMap((activity) =>
        activity.obstacle?.kind === "energy_stress_marker" ? [activity.obstacle.value] : [])),
      durationBuckets: tally(activities.map((activity) => activity.durationBucket)),
      systems: tally(activities.map((activity) => activity.system)),
    };
  }
}

/** Most frequent first; equal counts keep a stable alphabetical order. */
function tally<Value extends string>(values: Array<Value | undefined>): WeeklyActivityTally<Value>[] {
  const counts = new Map<Value, number>();
  for (const value of values) {
    if (value === undefined) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function shiftCalendarDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  if (Number.isNaN(shifted.valueOf())) throw new Error("calendar date must be ISO YYYY-MM-DD");
  return shifted.toISOString().slice(0, 10);
}
