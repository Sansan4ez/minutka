import { z } from "zod";
import type { TenantDirectoryStore } from "./tenant-directory-store.js";
import type { MutableWorkRetrospectivePolicyStore, RetrospectivePolicyRequest } from "./work-retrospective-policy.js";
import type { WorkRetrospectivePolicy } from "../domain/work-retrospective.js";

export const retrospectiveEnableSchema = z.strictObject({
  companyId: z.string().trim().min(1), groupId: z.string().trim().min(1),
  start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }),
  methodVersion: z.string().trim().min(1),
}).refine(v => Date.parse(v.start) < Date.parse(v.end), "start must precede end");
export type PolicyMutation = RetrospectivePolicyRequest & ({ action: "enable"; start: string; end: string; methodVersion: string } | { action: "disable" });
export type PolicyPreview = { policy: WorkRetrospectivePolicy; confirmation: string; action: "enable" | "disable" };
/** No messaging/scheduling dependencies. Confirmation is checked before any write.
 * Disable retains facts and persists a watermark, preserved by subsequent enable.
 */
export class WorkRetrospectivePolicyManagement {
  constructor(private readonly store: MutableWorkRetrospectivePolicyStore,
    private readonly directory: Pick<TenantDirectoryStore, "groupBelongsToCompany">,
    private readonly clock: { now(): string },
    private readonly audit: (event: { action: string; companyId: string; groupId: string; timestamp: string }) => Promise<void> = async () => {}) {}
  async inspect(scope: RetrospectivePolicyRequest) {
    if (!await this.directory.groupBelongsToCompany(scope)) throw new Error("group does not belong to company");
    return this.store.read(scope);
  }
  async preview(input: PolicyMutation): Promise<PolicyPreview> {
    const previous = await this.inspect(input);
    let policy: WorkRetrospectivePolicy;
    if (input.action === "enable") {
      const { action: _, ...raw } = input;
      const value = retrospectiveEnableSchema.parse(raw);
      policy = { companyId: value.companyId, groupId: value.groupId, enabled: true,
        period: { start: value.start, end: value.end }, methodVersion: value.methodVersion,
        ...(previous?.invalidatedAt ? { invalidatedAt: previous.invalidatedAt } : {}) };
    } else {
      policy = { ...(previous ?? { companyId: input.companyId, groupId: input.groupId,
        period: { start: this.clock.now(), end: this.clock.now() }, methodVersion: "disabled" }), enabled: false };
    }
    return { action: input.action, policy, confirmation: `${input.action.toUpperCase()} RETROSPECTIVE ${input.companyId}/${input.groupId}` };
  }
  async confirm(input: PolicyMutation, confirmation: string) {
    const preview = await this.preview(input);
    if (confirmation !== preview.confirmation) throw new Error("confirmation mismatch");
    const timestamp = this.clock.now();
    const policy = { ...preview.policy, ...(input.action === "disable" ? { invalidatedAt: timestamp } : {}) };
    await this.store.write(policy);
    await this.audit({ action: input.action, companyId: policy.companyId, groupId: policy.groupId, timestamp });
    return policy;
  }
}
