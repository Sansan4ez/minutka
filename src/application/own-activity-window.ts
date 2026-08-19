import type { PersonalActivityRecord } from "./activity-collection.js";

/**
 * The narrowest projection a personal summary needs. Subject keys, activity
 * ids, and message links stay out of it: a personal summary describes the
 * employee's own work and never carries research identifiers toward the model.
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

export type ActivityTally<Value extends string> = { value: Value; count: number };

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
