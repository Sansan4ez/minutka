const ianaTimezonePattern = /^[A-Za-z_+-][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;
const stableTimezoneOverrides = new Map<string, string>([
  ["asia/moscow", "Europe/Moscow"],
  ["gmt", "Etc/GMT"],
  ["utc", "Etc/UTC"],
  ["etc/gmt", "Etc/GMT"],
  ["etc/uct", "Etc/UCT"],
  ["etc/universal", "Etc/Universal"],
  ["etc/utc", "Etc/UTC"],
  ["etc/zulu", "Etc/Zulu"],
]);
const canonicalTimezones = new Map<string, string>();
for (const timezone of Intl.supportedValuesOf("timeZone")) canonicalTimezones.set(timezone.toLowerCase(), timezone);

/** Returns a canonical IANA identifier for a valid timezone. */
export function normalizeIanaTimezone(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate || candidate.length > 64 || !ianaTimezonePattern.test(candidate)) return undefined;
  try {
    const stableCandidate = stableTimezoneOverrides.get(candidate.toLowerCase());
    if (stableCandidate) return stableCandidate;
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
    return stableTimezoneOverrides.get(canonical.toLowerCase())
      ?? canonicalTimezones.get(canonical.toLowerCase())
      ?? canonical;
  } catch {
    return undefined;
  }
}

/** Converts an instant to an ISO calendar date in a validated IANA timezone. */
export function calendarDateInIanaTimezone(instant: string, timezone: string): string {
  const normalizedTimezone = normalizeIanaTimezone(timezone);
  if (!normalizedTimezone) throw new Error("timezone must be a valid IANA timezone");
  const date = new Date(instant);
  if (Number.isNaN(date.valueOf())) throw new Error("instant must be a valid timestamp");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: normalizedTimezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");
  if (!year || !month || !day) throw new Error("could not derive calendar date");
  return `${year}-${month}-${day}`;
}
