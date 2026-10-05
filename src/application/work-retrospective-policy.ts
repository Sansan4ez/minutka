import { activeProcessIds } from "./assistant-manual-loader.js";
import type { ProfileStore } from "./profile-store.js";
import type { TenantDirectoryStore, TrainingGroupPeriod } from "./tenant-directory-store.js";
import { startOfCalendarDateInIanaTimezone } from "../shared/iana-timezone.js";
import type { WorkRetrospectivePolicy } from "../domain/work-retrospective.js";
import { workRetrospectivePolicySchema } from "./work-retrospective-store.js";

export type RetrospectivePolicyRequest = { companyId: string; groupId: string; employeeId?: string; subjectKey?: string };
export type WorkRetrospectivePolicyStore = {
  read(request: RetrospectivePolicyRequest): Promise<WorkRetrospectivePolicy | undefined>;
  availability?(request: RetrospectivePolicyRequest): Promise<RetrospectiveAvailability | undefined>;
};
export type ResolvedRetrospectivePolicy =
  | { enabled: false; policy?: WorkRetrospectivePolicy }
  | { enabled: true; policy: WorkRetrospectivePolicy };
/** Trusted request supplies tenancy; no fallback to another group's policy. */
export async function resolveWorkRetrospectivePolicy(
  store: WorkRetrospectivePolicyStore,
  request: RetrospectivePolicyRequest,
  now: string,
): Promise<ResolvedRetrospectivePolicy> {
  const parsed = workRetrospectivePolicySchema.safeParse(await store.read(request));
  if (!parsed.success) return { enabled: false };
  const policy = parsed.data;
  const timestamp = Date.parse(now);
  if (policy.companyId !== request.companyId || policy.groupId !== request.groupId
    || !policy.enabled || !Number.isFinite(timestamp)) return { enabled: false };
  if (timestamp < Date.parse(policy.period.start) || timestamp >= Date.parse(policy.period.end)) {
    return store.availability ? { enabled: false, policy } : { enabled: false };
  }
  return { enabled: true, policy };
}

export const workRetrospectiveMethodVersion = "work-retrospective-v1";
export type RetrospectiveAvailability = {
  companyId: string; groupId: string; localPeriod: TrainingGroupPeriod;
  period: { start: string; end: string }; methodVersion: string;
};

/** Read-only production adapter: availability is derived, never managed here. */
export function createDirectoryWorkRetrospectivePolicyStore(input: {
  profiles: Pick<ProfileStore, "getParticipant" | "getProfile">;
  directory: Pick<TenantDirectoryStore, "getGroupPeriod">;
  processIds?: readonly string[];
}): WorkRetrospectivePolicyStore & { availability(request: RetrospectivePolicyRequest): Promise<RetrospectiveAvailability | undefined> } {
  const availability = async (request: RetrospectivePolicyRequest): Promise<RetrospectiveAvailability | undefined> => {
    if (!(input.processIds ?? activeProcessIds).includes("work_retrospective") || !request.employeeId) return undefined;
    const participant = await input.profiles.getParticipant(request.employeeId);
    if (!participant || participant.companyId !== request.companyId || participant.groupId !== request.groupId
      || participant.subjectKey !== request.subjectKey || participant.status !== "profile_completed") return undefined;
    const profile = await input.profiles.getProfile(request.employeeId);
    if (!profile || profile.companyId !== request.companyId || profile.groupId !== request.groupId) return undefined;
    const localPeriod = await input.directory.getGroupPeriod(request);
    if (!localPeriod) return undefined;
    try {
      const start = startOfCalendarDateInIanaTimezone(localPeriod.start, profile.timezone);
      // Validate the inclusive end before incrementing its calendar date.
      startOfCalendarDateInIanaTimezone(localPeriod.end, profile.timezone);
      const nextDate = new Date(Date.parse(`${localPeriod.end}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
      const end = startOfCalendarDateInIanaTimezone(nextDate, profile.timezone);
      if (start >= end) return undefined;
      return { companyId: request.companyId, groupId: request.groupId, localPeriod: { ...localPeriod }, period: { start, end }, methodVersion: workRetrospectiveMethodVersion };
    } catch { return undefined; }
  };
  return { availability, async read(request) {
    const value = await availability(request);
    return value && { companyId: value.companyId, groupId: value.groupId, enabled: true, period: value.period, methodVersion: value.methodVersion };
  } };
}

/** Offline adapter for policy fixtures. */
export class InMemoryWorkRetrospectivePolicyStore implements WorkRetrospectivePolicyStore {
  private readonly policies = new Map<string, WorkRetrospectivePolicy>();
  constructor(policies: WorkRetrospectivePolicy[] = []) {
    for (const policy of policies) {
      const parsed = workRetrospectivePolicySchema.parse(policy);
      this.policies.set(JSON.stringify([parsed.companyId, parsed.groupId]), parsed);
    }
  }
  /** Operator lifecycle operation; never exposed as an agent action. */
  async purge(scope: { companyId: string; groupId?: string }): Promise<number> {
    let deleted = 0;
    for (const [key, policy] of this.policies) {
      if (policy.companyId === scope.companyId && (!scope.groupId || policy.groupId === scope.groupId)) {
        this.policies.delete(key); deleted++;
      }
    }
    return deleted;
  }
  async read(request: RetrospectivePolicyRequest): Promise<WorkRetrospectivePolicy | undefined> {
    const policy = this.policies.get(JSON.stringify([request.companyId, request.groupId]));
    return policy ? structuredClone(policy) : undefined;
  }
}
