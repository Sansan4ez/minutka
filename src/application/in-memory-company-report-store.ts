import type { Participant } from "../domain/employee.js";
import type { InMemoryActivityCollectionState } from "./in-memory-activity-collection-store.js";
import type { CompanyReportStore } from "./company-reporting.js";

export function createInMemoryCompanyReportStore(input: {
  participants: Participant[];
  activities: InMemoryActivityCollectionState;
  reference?: NonNullable<Awaited<ReturnType<CompanyReportStore["loadGroupSnapshot"]>>["reference"]>;
}): CompanyReportStore {
  return {
    async loadGroupSnapshot({ companyId, groupId }) {
      const participants = input.participants.filter(
        (participant) => participant.companyId === companyId && participant.groupId === groupId,
      );
      return {
        invitedParticipants: participants.length,
        subjects: participants.map(({ subjectKey, roleId }) => ({ subjectKey, ...(roleId ? { roleId } : {}) })),
        activities: input.activities.activities
          .filter((activity) => activity.companyId === companyId
            && activity.groupId === groupId
            && (activity.status ?? "active") === "active")
          .map(({ employeeId: _employeeId, sourceMessageId: _sourceMessageId, ...activity }) => structuredClone(activity)),
        ...(input.reference === undefined ? {} : { reference: structuredClone(input.reference) }),
      };
    },
  };
}
