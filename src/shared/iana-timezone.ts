const ianaTimezonePattern = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/u;
const canonicalTimezoneOverrides = new Map<string, string>([
  ["etc/utc", "Etc/UTC"],
]);
for (const timezone of Intl.supportedValuesOf("timeZone")) canonicalTimezoneOverrides.set(timezone.toLowerCase(), timezone);

/** Returns a canonical IANA identifier for a valid timezone. */
export function normalizeIanaTimezone(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate || candidate.length > 64 || !ianaTimezonePattern.test(candidate)) return undefined;
  try {
    const canonical = new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
    return canonicalTimezoneOverrides.get(canonical.toLowerCase()) ?? canonicalTimezoneOverrides.get(candidate.toLowerCase()) ?? canonical;
  } catch {
    return undefined;
  }
}
