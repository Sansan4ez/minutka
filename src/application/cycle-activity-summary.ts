import type {
  ActivityDurationBucket,
  ActivitySystem,
  AutomationCandidateType,
  EnergyStressMarkerType,
  RoutinePatternType,
  TaskCategory,
} from "../domain/insights.js";
import { calendarDateInIanaTimezone } from "../shared/iana-timezone.js";
import {
  ownActivitiesInWindow,
  shiftCalendarDate,
  tally,
  type ActivityTally,
  type OwnActivityReadStore,
} from "./own-activity-window.js";
import { systemClock, type Clock } from "./runtime-primitives.js";

/**
 * Inclusive local-date horizon of the final personal report — the two-week
 * programme cycle. The operator runs the report at the end of the cycle, so the
 * window is anchored on the employee's today instead of the group period row.
 */
export const cycleSummaryWindowDays = 14;

/** Below this the cycle is reported as thin instead of being called a picture of two weeks. */
export const cycleSummarySufficiency = { activities: 6, activeDates: 4 } as const;

/**
 * A value seen once over two weeks is an episode, not a pattern. The final
 * report may call a pattern only what the application confirmed as repeated.
 */
export const cyclePatternMinimumCount = 2;

/** Values that repeated inside the cycle. Duration is a size, not a pattern, so it has no entry. */
export type CycleConfirmedPatterns = {
  taskCategories: TaskCategory[];
  routinePatterns: RoutinePatternType[];
  automationCandidates: AutomationCandidateType[];
  energyStressMarkers: EnergyStressMarkerType[];
  systems: ActivitySystem[];
};

export type CycleActivitySummary = {
  fromDate: string;
  toDate: string;
  activityCount: number;
  activeDates: number;
  /** False when the cycle is too thin to describe two weeks honestly. */
  sufficientData: boolean;
  patternMinimumCount: number;
  taskCategories: ActivityTally<TaskCategory>[];
  routinePatterns: ActivityTally<RoutinePatternType>[];
  automationCandidates: ActivityTally<AutomationCandidateType>[];
  energyStressMarkers: ActivityTally<EnergyStressMarkerType>[];
  durationBuckets: ActivityTally<ActivityDurationBucket>[];
  systems: ActivityTally<ActivitySystem>[];
  confirmedPatterns: CycleConfirmedPatterns;
};

/**
 * Typed owner-scoped read behind the final personal report. It counts the same
 * canonical activities as the weekly checkpoint over the whole cycle and
 * decides in the application which of them repeated, so the report rests on
 * confirmed patterns instead of a retelling of every activity.
 */
export class CycleActivitySummaryService {
  constructor(
    private readonly store: OwnActivityReadStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async summarize(input: { employeeId: string; timezone: string }): Promise<CycleActivitySummary> {
    const employeeId = input.employeeId.trim();
    if (!employeeId) throw new Error("employeeId is required");
    const toDate = calendarDateInIanaTimezone(this.clock.now(), input.timezone);
    const fromDate = shiftCalendarDate(toDate, 1 - cycleSummaryWindowDays);
    const window = { employeeId, fromDate, toDate };
    const activities = ownActivitiesInWindow(await this.store.listOwnActivities(window), window);
    const activeDates = new Set(activities.map((activity) => activity.activityDate)).size;

    const taskCategories = tally(activities.map((activity) => activity.taskCategory));
    const routinePatterns = tally(activities.flatMap((activity) =>
      activity.obstacle?.kind === "routine_pattern" ? [activity.obstacle.value] : []));
    const automationCandidates = tally(activities.flatMap((activity) =>
      activity.obstacle?.kind === "automation_candidate" ? [activity.obstacle.value] : []));
    const energyStressMarkers = tally(activities.flatMap((activity) =>
      activity.obstacle?.kind === "energy_stress_marker" ? [activity.obstacle.value] : []));
    const systems = tally(activities.map((activity) => activity.system));

    return {
      fromDate,
      toDate,
      activityCount: activities.length,
      activeDates,
      sufficientData: activities.length >= cycleSummarySufficiency.activities
        && activeDates >= cycleSummarySufficiency.activeDates,
      patternMinimumCount: cyclePatternMinimumCount,
      taskCategories,
      routinePatterns,
      automationCandidates,
      energyStressMarkers,
      durationBuckets: tally(activities.map((activity) => activity.durationBucket)),
      systems,
      confirmedPatterns: {
        taskCategories: repeated(taskCategories),
        routinePatterns: repeated(routinePatterns),
        automationCandidates: repeated(automationCandidates),
        energyStressMarkers: repeated(energyStressMarkers),
        systems: repeated(systems),
      },
    };
  }
}

function repeated<Value extends string>(tallies: ActivityTally<Value>[]): Value[] {
  return tallies.filter(({ count }) => count >= cyclePatternMinimumCount).map(({ value }) => value);
}
