export type InviteSeed = {
  employeeId: string;
  inviteCode: string;
};

/** Parses local-only bootstrap invites before the durable Telegram runtime starts. */
export function parseInviteSeeds(value: string | undefined): InviteSeed[] {
  if (!value?.trim()) return [];

  const seeds = value.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    if (separator < 1 || separator === entry.length - 1) {
      throw new Error("TELEGRAM_INVITES must use employeeId:inviteCode entries");
    }
    return {
      employeeId: entry.slice(0, separator).trim(),
      inviteCode: entry.slice(separator + 1).trim(),
    };
  });

  if (seeds.some((seed) => !seed.employeeId || !seed.inviteCode)) {
    throw new Error("TELEGRAM_INVITES contains an empty employeeId or inviteCode");
  }
  if (new Set(seeds.map((seed) => seed.employeeId)).size !== seeds.length) {
    throw new Error("TELEGRAM_INVITES contains duplicate employeeIds");
  }
  if (new Set(seeds.map((seed) => seed.inviteCode)).size !== seeds.length) {
    throw new Error("TELEGRAM_INVITES contains duplicate inviteCodes");
  }
  return seeds;
}
