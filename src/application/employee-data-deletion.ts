import { z } from "zod";
import type { RetrospectiveLifecycle, RetrospectiveDeletionCounts } from "./retrospective-lifecycle.js";
import type { ProfileStore, EmployeePersonalDataDeletionCounts } from "./profile-store.js";

const deleteEmployeeDataInputSchema = z.strictObject({
  employeeId: z.string().trim().min(1),
});

export type DeleteEmployeeDataInput = z.input<typeof deleteEmployeeDataInputSchema>;

/** Physical owner-scoped objects. Implementations must remove every version under the employee prefix. */
export type EmployeeObjectDeletionStore = {
  deleteByEmployee(employeeId: string): Promise<{ deletedObjectVersions: number }>;
};

export type EmployeeDataDeletionResult = {
  employeeId: string;
  deleted: EmployeePersonalDataDeletionCounts & Partial<RetrospectiveDeletionCounts> & { minioObjectVersions: number };
  preserved: {
    anonymousDeletionAudit: true;
    aggregateUsageCounters: "not_configured";
    deliveredClientArtifacts: "not_recalled";
  };
  oldInviteRevoked: true;
};

/**
 * Irreversible operator-only use-case. It is intentionally not exposed as an agent tool.
 * Object versions are removed before the database owner root so a storage failure leaves
 * the employee identity available for a safe retry.
 */
export class EmployeeDataDeletionService {
  constructor(
    private readonly profiles: Pick<ProfileStore, "getParticipant" | "deleteEmployeePersonalData">,
    private readonly objects: EmployeeObjectDeletionStore,
    private readonly retrospective?: RetrospectiveLifecycle,
  ) {}

  async deleteEmployeeData(input: DeleteEmployeeDataInput): Promise<EmployeeDataDeletionResult> {
    const { employeeId } = deleteEmployeeDataInputSchema.parse(input);
    const participant = await this.profiles.getParticipant(employeeId);
    if (!participant) throw new Error("employee_not_found");
    const scope = { companyId: participant.companyId, groupId: participant.groupId, subjectKey: participant.subjectKey };
    const derivedCounts = await this.retrospective?.preview(scope);
    const derived = await this.retrospective?.purge(scope);
    const objects = await this.objects.deleteByEmployee(employeeId);
    objects.deletedObjectVersions += derived?.deletedObjectVersions ?? 0;
    const deleted = await this.profiles.deleteEmployeePersonalData(employeeId);
    return {
      employeeId,
      deleted: { ...deleted, ...derivedCounts, minioObjectVersions: objects.deletedObjectVersions },
      preserved: {
        anonymousDeletionAudit: true,
        aggregateUsageCounters: "not_configured",
        deliveredClientArtifacts: "not_recalled",
      },
      oldInviteRevoked: true,
    };
  }
}
