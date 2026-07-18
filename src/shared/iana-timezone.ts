const ianaTimezonePattern = /^[A-Za-z_+-][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u;
const stableTimezoneOverrides = new Map<string, string>([
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
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
    const stableCandidate = stableTimezoneOverrides.get(candidate.toLowerCase());
    if (stableCandidate) return stableCandidate;
    return stableTimezoneOverrides.get(canonical.toLowerCase())
      ?? canonicalTimezones.get(canonical.toLowerCase())
      ?? canonical;
  } catch {
    return undefined;
  }
}
