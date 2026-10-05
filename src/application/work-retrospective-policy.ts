import type { WorkRetrospectivePolicy } from "../domain/work-retrospective.js";
import { workRetrospectivePolicySchema } from "./work-retrospective-store.js";

export type RetrospectivePolicyRequest = { companyId: string; groupId: string };
export type WorkRetrospectivePolicyStore = {
  read(request: RetrospectivePolicyRequest): Promise<WorkRetrospectivePolicy | undefined>;
};
export type MutableWorkRetrospectivePolicyStore = WorkRetrospectivePolicyStore & {
  write(policy: WorkRetrospectivePolicy): Promise<void>;
  purge(scope: { companyId: string; groupId?: string }): Promise<number>;
};
export type ResolvedRetrospectivePolicy =
  | { enabled: false }
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
    || !policy.enabled || !Number.isFinite(timestamp)
    || timestamp < Date.parse(policy.period.start) || timestamp > Date.parse(policy.period.end)) {
    return { enabled: false };
  }
  return { enabled: true, policy };
}

/** Mutable offline adapter; mutations belong to operator use-cases only. */
export class InMemoryWorkRetrospectivePolicyStore implements WorkRetrospectivePolicyStore {
  private readonly policies = new Map<string, WorkRetrospectivePolicy>();
  constructor(policies: WorkRetrospectivePolicy[] = []) {
    for (const policy of policies) {
      const parsed = workRetrospectivePolicySchema.parse(policy);
      this.policies.set(JSON.stringify([parsed.companyId, parsed.groupId]), parsed);
    }
  }
  async write(policy: WorkRetrospectivePolicy): Promise<void> {
    const parsed = workRetrospectivePolicySchema.parse(policy);
    this.policies.set(JSON.stringify([parsed.companyId, parsed.groupId]), structuredClone(parsed));
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
