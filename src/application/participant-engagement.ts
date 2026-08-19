import { calendarDateInIanaTimezone } from "../shared/iana-timezone.js";

export const participantEngagements = ["active", "lagging", "dropped_off"] as const;
export type ParticipantEngagement = typeof participantEngagements[number];

const millisecondsPerDay = 24 * 60 * 60 * 1_000;
const laggingAfterMissedDays = 2;
const droppedOffAfterMissedDays = 3;

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
  const missedDays = Math.max(0, dateOrdinal(today) - dateOrdinal(input.lastTouchOn));
  if (missedDays >= droppedOffAfterMissedDays) return "dropped_off";
  if (missedDays >= laggingAfterMissedDays) return "lagging";
  return "active";
}

function dateOrdinal(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!) / millisecondsPerDay;
}
