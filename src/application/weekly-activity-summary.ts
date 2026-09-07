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
  routineSummaries,
  shiftCalendarDate,
  tally,
  type ActivityTally,
  type OwnActivityReadStore,
  type PersonalRoutineSummary,
} from "./own-activity-window.js";
import { systemClock, type Clock } from "./runtime-primitives.js";

/** Inclusive local-date window of the weekly personal checkpoint. */
export const weeklySummaryWindowDays = 7;

/**
 * Below this the summary reports the window as thin instead of naming a
 * pattern. One busy day is not a week, and a single activity is not a routine.
 */
export const weeklySummarySufficiency = { activities: 3, activeDates: 2 } as const;

export type WeeklyActivitySummary = {
  fromDate: string;
  toDate: string;
  activityCount: number;
  activeDates: number;
  /** False when the window is too thin to name a pattern honestly. */
  sufficientData: boolean;
  taskCategories: ActivityTally<TaskCategory>[];
  routinePatterns: ActivityTally<RoutinePatternType>[];
  automationCandidates: ActivityTally<AutomationCandidateType>[];
  energyStressMarkers: ActivityTally<EnergyStressMarkerType>[];
  durationBuckets: ActivityTally<ActivityDurationBucket>[];
  systems: ActivityTally<ActivitySystem>[];
  routines: PersonalRoutineSummary[];
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
    const window = { employeeId, fromDate, toDate };
    const activities = ownActivitiesInWindow(await this.store.listOwnActivities(window), window);
    const activeDates = new Set(activities.map((activity) => activity.activityDate)).size;

    return {
      fromDate,
      toDate,
      activityCount: activities.length,
      activeDates,
      sufficientData: activities.length >= weeklySummarySufficiency.activities
        && activeDates >= weeklySummarySufficiency.activeDates,
      taskCategories: tally(activities.map((activity) => activity.taskCategory)),
      routinePatterns: tally(activities.map((activity) => activity.routinePattern)),
      automationCandidates: tally(activities.map((activity) => activity.automationCandidate)),
      energyStressMarkers: tally(activities.map((activity) => activity.energyStressMarker)),
      durationBuckets: tally(activities.map((activity) => activity.durationBucket)),
      systems: tally(activities.map((activity) => activity.system)),
      routines: routineSummaries(activities, { limit: 3 }),
    };
  }
}
