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
import type { TrainingGroupPeriod } from "./tenant-directory-store.js";

/**
 * Fallback inclusive local-date horizon of the final personal report — the
 * nominal two-week programme cycle. It applies only when the participant's
 * group carries no period; otherwise the report counts the group period, the
 * same inclusive dates the company report filters activities by.
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

export type CycleActivitySummaryInput = {
  employeeId: string;
  timezone: string;
  /** The group's cycle; absent only for a participant without a directory group. */
  period?: TrainingGroupPeriod;
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
  routines: PersonalRoutineSummary[];
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

  async summarize(input: CycleActivitySummaryInput): Promise<CycleActivitySummary> {
    const employeeId = input.employeeId.trim();
    if (!employeeId) throw new Error("employeeId is required");
    const today = calendarDateInIanaTimezone(this.clock.now(), input.timezone);
    const { fromDate, toDate } = cycleWindow(today, input.period);
    const window = { employeeId, fromDate, toDate };
    const activities = ownActivitiesInWindow(await this.store.listOwnActivities(window), window);
    const activeDates = new Set(activities.map((activity) => activity.activityDate)).size;
    const sufficientData = activities.length >= cycleSummarySufficiency.activities
      && activeDates >= cycleSummarySufficiency.activeDates;

    const taskCategories = tally(activities.map((activity) => activity.taskCategory));
    const routinePatterns = tally(activities.map((activity) => activity.routinePattern));
    const automationCandidates = tally(activities.map((activity) => activity.automationCandidate));
    const energyStressMarkers = tally(activities.map((activity) => activity.energyStressMarker));
    const systems = tally(activities.map((activity) => activity.system));

    return {
      fromDate,
      toDate,
      activityCount: activities.length,
      activeDates,
      sufficientData,
      patternMinimumCount: cyclePatternMinimumCount,
      taskCategories,
      routinePatterns,
      automationCandidates,
      energyStressMarkers,
      durationBuckets: tally(activities.map((activity) => activity.durationBucket)),
      systems,
      routines: sufficientData ? routineSummaries(activities, { minimumCount: cyclePatternMinimumCount }) : [],
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

/**
 * The personal report counts the group period as inclusive local dates, cut at
 * the employee's today when the report runs before the cycle ends, so the run
 * date never changes which cycle days are counted. Without a period the window
 * is the last fourteen local days ending today.
 */
export function cycleWindow(today: string, period?: TrainingGroupPeriod): { fromDate: string; toDate: string } {
  if (period === undefined) return { fromDate: shiftCalendarDate(today, 1 - cycleSummaryWindowDays), toDate: today };
  return { fromDate: period.start, toDate: period.end < today ? period.end : today };
}

function repeated<Value extends string>(tallies: ActivityTally<Value>[]): Value[] {
  return tallies.filter(({ count }) => count >= cyclePatternMinimumCount).map(({ value }) => value);
}
