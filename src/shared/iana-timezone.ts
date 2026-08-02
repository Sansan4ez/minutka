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

const timezoneAliases = new Map<string, string>();
function addTimezoneAliases(timezone: string, aliases: string[]): void {
  for (const alias of aliases) timezoneAliases.set(normalizeTimezoneAliasKey(alias), timezone);
}
addTimezoneAliases("Europe/Kaliningrad", ["калининград", "kaliningrad"]);
addTimezoneAliases("Europe/Moscow", ["москва", "московское время", "мск", "msk", "moscow", "санкт-петербург", "санкт петербург", "спб", "петербург", "питер", "saint petersburg", "st petersburg"]);
addTimezoneAliases("Europe/Samara", ["самара", "samara"]);
addTimezoneAliases("Asia/Yekaterinburg", ["екатеринбург", "екб", "yekaterinburg", "ekaterinburg"]);
addTimezoneAliases("Asia/Omsk", ["омск", "omsk"]);
addTimezoneAliases("Asia/Krasnoyarsk", ["красноярск", "krasnoyarsk"]);
addTimezoneAliases("Asia/Irkutsk", ["иркутск", "irkutsk"]);
addTimezoneAliases("Asia/Vladivostok", ["владивосток", "vladivostok"]);
addTimezoneAliases("Asia/Novosibirsk", ["новосибирск", "novosibirsk"]);
addTimezoneAliases("Asia/Tomsk", ["томск", "tomsk"]);
addTimezoneAliases("Asia/Yakutsk", ["якутск", "yakutsk"]);
addTimezoneAliases("Asia/Magadan", ["магадан", "magadan"]);
addTimezoneAliases("Asia/Kamchatka", ["камчатка", "петропавловск-камчатский", "petropavlovsk kamchatsky", "kamchatka"]);
addTimezoneAliases("Asia/Sakhalin", ["сахалин", "южно-сахалинск", "sakhalin"]);
addTimezoneAliases("Europe/Volgograd", ["волгоград", "volgograd"]);
addTimezoneAliases("Europe/Saratov", ["саратов", "saratov"]);
addTimezoneAliases("Europe/Astrakhan", ["астрахань", "astrakhan"]);
addTimezoneAliases("Europe/Ulyanovsk", ["ульяновск", "ulyanovsk"]);
addTimezoneAliases("Europe/Kirov", ["киров", "kirov"]);
addTimezoneAliases("Europe/Simferopol", ["симферополь", "крым", "simferopol", "crimea"]);
addTimezoneAliases("Europe/Minsk", ["минск", "беларусь", "белоруссия", "minsk", "belarus"]);
addTimezoneAliases("Europe/Kyiv", ["киев", "київ", "kyiv", "kiev"]);
addTimezoneAliases("Europe/Chisinau", ["кишинёв", "кишинев", "chisinau"]);
addTimezoneAliases("Asia/Tbilisi", ["тбилиси", "грузия", "tbilisi", "georgia"]);
addTimezoneAliases("Asia/Yerevan", ["ереван", "армения", "yerevan", "armenia"]);
addTimezoneAliases("Asia/Baku", ["баку", "азербайджан", "baku", "azerbaijan"]);
addTimezoneAliases("Asia/Almaty", ["алматы", "астана", "казахстан", "almaty", "astana", "kazakhstan"]);
addTimezoneAliases("Asia/Bishkek", ["бишкек", "кыргызстан", "киргизия", "bishkek", "kyrgyzstan"]);
addTimezoneAliases("Asia/Tashkent", ["ташкент", "узбекистан", "tashkent", "uzbekistan"]);
addTimezoneAliases("Asia/Dushanbe", ["душанбе", "таджикистан", "dushanbe", "tajikistan"]);
addTimezoneAliases("Asia/Ashgabat", ["ашхабад", "туркменистан", "ashgabat", "turkmenistan"]);
addTimezoneAliases("America/New_York", ["нью-йорк", "нью йорк", "new york", "nyc"]);

function normalizeTimezoneAliasKey(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е").replace(/[‐‑‒–—−-]+/gu, " ").replace(/[«»"']/gu, " ").replace(/\s+/gu, " ").trim();
}

function offsetTimezone(offsetHours: number): string | undefined {
  if (!Number.isInteger(offsetHours) || offsetHours < -12 || offsetHours > 14) return undefined;
  if (offsetHours === 0) return "Etc/UTC";
  return `Etc/GMT${offsetHours > 0 ? "-" : "+"}${Math.abs(offsetHours)}`;
}

/** Resolves common city, region, and fixed-offset input to a canonical IANA identifier. */
export function resolveTimezoneAlias(value: string): string | undefined {
  const candidate = value.trim().replace(/[.,;!?]+$/u, "").trim();
  if (!candidate || candidate.length > 64) return undefined;
  const compact = candidate.replace(/\s+/gu, "");
  const utcOffset = compact.match(/^(?:utc|gmt)?([+-])(\d{1,2})(?::?00)?$/iu);
  if (utcOffset) {
    const hours = Number(utcOffset[2]) * (utcOffset[1] === "+" ? 1 : -1);
    return offsetTimezone(hours);
  }
  const moscowOffset = compact.match(/^(?:мск|msk)([+-])(\d{1,2})$/iu);
  if (moscowOffset) {
    const hours = 3 + Number(moscowOffset[2]) * (moscowOffset[1] === "+" ? 1 : -1);
    return offsetTimezone(hours);
  }
  const aliasTimezone = timezoneAliases.get(normalizeTimezoneAliasKey(candidate));
  return aliasTimezone ? normalizeIanaTimezone(aliasTimezone) : undefined;
}

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
