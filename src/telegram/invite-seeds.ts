export type InviteSeed = {
  employeeId: string;
  inviteCode: string;
  companyId: string;
  groupId: string;
};

/** Parses local-only bootstrap invites before the durable Telegram runtime starts. */
export function parseInviteSeeds(value: string | undefined): InviteSeed[] {
  if (!value?.trim()) return [];

  const seeds = value.split(",").map((entry) => {
    const fields = entry.split(":").map((field) => field.trim());
    if (fields.length !== 4) {
      throw new Error("TELEGRAM_INVITES must use employeeId:inviteCode:companyId:groupId entries");
    }
    return { employeeId: fields[0]!, inviteCode: fields[1]!, companyId: fields[2]!, groupId: fields[3]! };
  });

  if (seeds.some((seed) => !seed.employeeId || !seed.inviteCode || !seed.companyId || !seed.groupId)) {
    throw new Error("TELEGRAM_INVITES contains an empty employeeId, inviteCode, companyId, or groupId");
  }
  if (new Set(seeds.map((seed) => seed.employeeId)).size !== seeds.length) {
    throw new Error("TELEGRAM_INVITES contains duplicate employeeIds");
  }
  if (new Set(seeds.map((seed) => seed.inviteCode)).size !== seeds.length) {
    throw new Error("TELEGRAM_INVITES contains duplicate inviteCodes");
  }
  return seeds;
}
