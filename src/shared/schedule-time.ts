import { normalizeIanaTimezone } from "./iana-timezone.js";

const dailyTimePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function normalizeDailyTime(value: string): string {
  const candidate = value.trim();
  if (!dailyTimePattern.test(candidate)) throw new Error("timeOfDay must be HH:mm");
  return candidate;
}

export function normalizeDaysOfWeek(value: number | undefined): number {
  const candidate = value ?? 127;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 127) {
    throw new Error("daysOfWeek must be between 1 and 127");
  }
  return candidate;
}

/** Returns the first allowed wall-clock occurrence strictly after an instant. */
export function nextDailyFireAt(input: { after: string; timeOfDay: string; timezone: string; daysOfWeek?: number }): string {
  const after = new Date(input.after);
  if (Number.isNaN(after.valueOf())) throw new Error("after must be a valid timestamp");
  const timezone = normalizeIanaTimezone(input.timezone);
  if (!timezone) throw new Error("timezone must be a valid IANA timezone");
  const daysOfWeek = normalizeDaysOfWeek(input.daysOfWeek);
  const [hour, minute] = normalizeDailyTime(input.timeOfDay).split(":").map(Number) as [number, number];
  const localDate = localParts(after, timezone);

  // Eight local dates cover a single-day mask up to the same weekday next week,
  // with one extra candidate for a skipped local date. DST edge behavior is not
  // part of the pilot contract; nonexistent wall times are safely skipped.
  for (let offset = 0; offset < 8; offset += 1) {
    const date = new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day + offset));
    const weekdayBit = 1 << ((date.getUTCDay() + 6) % 7);
    if ((daysOfWeek & weekdayBit) === 0) continue;
    const target: LocalDateTime = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour,
      minute,
    };
    const candidate = instantForLocalDateTime(target, timezone);
    if (candidate !== undefined && candidate.valueOf() > after.valueOf()) return candidate.toISOString();
  }
  throw new Error("could not calculate next daily fire");
}

function instantForLocalDateTime(target: LocalDateTime, timezone: string): Date | undefined {
  const targetAsUtc = Date.UTC(target.year, target.month - 1, target.day, target.hour, target.minute);
  let guess = targetAsUtc;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const actual = localParts(new Date(guess), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    const correction = targetAsUtc - actualAsUtc;
    if (correction === 0) return new Date(guess);
    guess += correction;
  }
  const resolved = localParts(new Date(guess), timezone);
  return sameLocalDateTime(resolved, target) ? new Date(guess) : undefined;
}

function localParts(instant: Date, timezone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const numberPart = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = Number(parts.find((part) => part.type === type)?.value);
    if (!Number.isInteger(value)) throw new Error(`could not derive local ${type}`);
    return value;
  };
  return {
    year: numberPart("year"),
    month: numberPart("month"),
    day: numberPart("day"),
    hour: numberPart("hour"),
    minute: numberPart("minute"),
  };
}

function sameLocalDateTime(left: LocalDateTime, right: LocalDateTime): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day
    && left.hour === right.hour && left.minute === right.minute;
}
