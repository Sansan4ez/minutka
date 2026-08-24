import { calendarDateInIanaTimezone } from "../shared/iana-timezone.js";

export const participantEngagements = ["active", "lagging", "dropped_off"] as const;
export type ParticipantEngagement = typeof participantEngagements[number];

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const laggingAfterMissedDays = 2;
const droppedOffAfterMissedDays = 3;
const monday = 1;
const friday = 5;

export function participantEngagement(input: {
  lastTouchOn?: string;
  now: string;
  timezone: string;
}): ParticipantEngagement {
  // Onboarding completion seeds the first touch, so an absent one means the
  // employee has not finished onboarding yet: there is no participation clock to
  // degrade, and the participation status already reports that stage.
  if (!input.lastTouchOn) return "active";
  const today = calendarDateInIanaTimezone(input.now, input.timezone);
  const missedWorkingDays = completedWorkingDaysBetween(input.lastTouchOn, today);
  if (missedWorkingDays >= droppedOffAfterMissedDays) return "dropped_off";
  if (missedWorkingDays >= laggingAfterMissedDays) return "lagging";
  return "active";
}

function completedWorkingDaysBetween(lastTouchOn: string, today: string): number {
  const from = dateOrdinal(lastTouchOn);
  const to = dateOrdinal(today);
  let workingDays = 0;
  for (let day = from + 1; day < to; day += 1) {
    const weekday = new Date(day * millisecondsPerDay).getUTCDay();
    if (weekday >= monday && weekday <= friday) workingDays += 1;
  }
  return workingDays;
}

function dateOrdinal(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!) / millisecondsPerDay;
}
