const ianaTimezonePattern = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/u;
const canonicalTimezoneOverrides = new Map<string, string>([
  ["etc/gmt", "Etc/GMT"],
  ["etc/uct", "Etc/UCT"],
  ["etc/universal", "Etc/Universal"],
  ["etc/utc", "Etc/UTC"],
  ["etc/zulu", "Etc/Zulu"],
]);
for (const timezone of Intl.supportedValuesOf("timeZone")) canonicalTimezoneOverrides.set(timezone.toLowerCase(), timezone);

/** Returns a canonical IANA identifier for a valid timezone. */
export function normalizeIanaTimezone(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate || candidate.length > 64 || !ianaTimezonePattern.test(candidate)) return undefined;
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
    const normalizedCandidate = canonicalTimezoneOverrides.get(candidate.toLowerCase()) ?? candidate;
    const normalizedCanonical = canonicalTimezoneOverrides.get(canonical.toLowerCase()) ?? canonical;
    return ianaTimezonePattern.test(normalizedCanonical) ? normalizedCanonical : normalizedCandidate;
  } catch {
    return undefined;
  }
}
