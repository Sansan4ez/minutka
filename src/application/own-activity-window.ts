import type { PersonalActivityRecord } from "./activity-collection.js";
import type { ActivityRecurrence } from "../domain/insights.js";

/**
 * The narrowest projection a personal summary needs. Subject keys, activity
 * ids, and message links stay out of it: a personal summary describes the
 * employee's own work and never carries research identifiers toward the model.
 */
export type OwnActivityFacet = Pick<
  PersonalActivityRecord,
  "employeeId" | "taskCategory" | "routinePattern" | "automationCandidate" | "energyStressMarker" | "durationBucket" | "system" | "routineId" | "routineLabel" | "recurrence" | "activityDate"
>;

export type OwnActivityWindow = { employeeId: string; fromDate: string; toDate: string };

export type OwnActivityReadStore = {
  /** Returns one employee's own activities inside an inclusive local-date window. */
  listOwnActivities(window: OwnActivityWindow): Promise<OwnActivityFacet[]>;
};

export type ActivityTally<Value extends string> = { value: Value; count: number };

export type PersonalRoutineSummary = {
  label: string;
  count: number;
  activeDates: number;
  statedRecurrence?: Partial<Record<ActivityRecurrence, number>>;
};

/**
 * Groups only labelled own activities into the employee-facing routine view.
 * Directory ids win over free-text keys, while the displayed label always comes
 * from the employee's own most frequently reported wording.
 */
export function routineSummaries(
  activities: OwnActivityFacet[],
  options: { minimumCount?: number; limit?: number } = {},
): PersonalRoutineSummary[] {
  const minimumCount = options.minimumCount ?? 1;
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const groups = new Map<string, OwnActivityFacet[]>();
  for (const activity of activities) {
    if (activity.routineId === undefined && activity.routineLabel === undefined) continue;
    const key = activity.routineId === undefined
      ? `label:${routineKey(activity.routineLabel!)}`
      : `id:${activity.routineId}`;
    groups.set(key, [...(groups.get(key) ?? []), activity]);
  }

  return [...groups.values()]
    .map((group, index) => {
      const labels = tallyLabels(group.flatMap((activity) => activity.routineLabel === undefined ? [] : [activity.routineLabel]));
      if (labels.length === 0) return undefined;
      const recurrence = tallyRecurrences(group);
      return {
        label: labels[0]!.value,
        count: group.length,
        activeDates: new Set(group.map((activity) => activity.activityDate)).size,
        ...(recurrence.length === 0 ? {} : { statedRecurrence: Object.fromEntries(recurrence.map(({ value, count }) => [value, count])) }),
        __groupIndex: index,
      } satisfies PersonalRoutineSummary & { __groupIndex: number };
    })
    .filter((routine): routine is PersonalRoutineSummary & { __groupIndex: number } => routine !== undefined && routine.count >= minimumCount)
    .sort((left, right) => right.count - left.count || left.__groupIndex - right.__groupIndex)
    .slice(0, limit)
    .map(({ __groupIndex: _groupIndex, ...routine }) => routine);
}

/** The company report and personal summaries use the same free-label grouping key. */
export function routineKey(label: string): string {
  return label.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ").replace(/[\p{P}]/gu, "").replace(/\s+/gu, " ");
}

function tallyLabels(values: string[]): ActivityTally<string>[] {
  const labels = new Map<string, ActivityTally<string>>();
  for (const value of values) {
    const key = routineKey(value);
    const existing = labels.get(key);
    labels.set(key, existing === undefined ? { value, count: 1 } : { ...existing, count: existing.count + 1 });
  }
  return [...labels.values()].sort((left, right) => right.count - left.count);
}

function tallyRecurrences(activities: OwnActivityFacet[]): ActivityTally<ActivityRecurrence>[] {
  return tally(activities.map((activity) => activity.recurrence));
}

/** Most frequent first; equal counts keep a stable alphabetical order. */
export function tally<Value extends string>(values: Array<Value | undefined>): ActivityTally<Value>[] {
  const counts = new Map<Value, number>();
  for (const value of values) {
    if (value === undefined) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

export function shiftCalendarDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  if (Number.isNaN(shifted.valueOf())) throw new Error("calendar date must be ISO YYYY-MM-DD");
  return shifted.toISOString().slice(0, 10);
}

/**
 * Owner isolation does not depend on the adapter: another employee's row or an
 * out-of-window row can never reach a personal summary.
 */
export function ownActivitiesInWindow(listed: OwnActivityFacet[], window: OwnActivityWindow): OwnActivityFacet[] {
  return listed.filter((activity) =>
    activity.employeeId === window.employeeId
    && activity.activityDate >= window.fromDate
    && activity.activityDate <= window.toDate);
}
