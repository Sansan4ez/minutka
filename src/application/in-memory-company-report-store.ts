import type { Participant } from "../domain/employee.js";
import type { InMemoryActivityCollectionState } from "./in-memory-activity-collection-store.js";
import type { CompanyReportStore } from "./company-reporting.js";

export function createInMemoryCompanyReportStore(input: {
  participants: Participant[];
  activities: InMemoryActivityCollectionState;
}): CompanyReportStore {
  return {
    async loadGroupSnapshot({ companyId, groupId }) {
      const participants = input.participants.filter(
        (participant) => participant.companyId === companyId && participant.groupId === groupId,
      );
      const byRole = new Map<string, number>();
      for (const participant of participants) {
        if (participant.roleId) byRole.set(participant.roleId, (byRole.get(participant.roleId) ?? 0) + 1);
      }
      return {
        participantCounts: { group: participants.length, byRole },
        anonymizedActivities: input.activities.anonymizedActivities.filter(
          (activity) => activity.companyId === companyId && activity.groupId === groupId,
        ),
      };
    },
  };
}
