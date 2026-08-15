import type { AnonymizedActivityRecord } from "./activity-collection.js";

/** Pilot privacy thresholds from RFC §2.4. Keep both policy values together. */
export const COMPANY_REPORT_MIN_PARTICIPANTS = 5;
export const COMPANY_REPORT_MIN_ROWS = 5;

export type CompanyReportParticipantCounts = {
  group: number;
  byRole: ReadonlyMap<string, number>;
};

export type CompanyReportSnapshot = {
  participantCounts: CompanyReportParticipantCounts;
  anonymizedActivities: AnonymizedActivityRecord[];
};

export type CompanyReportStore = {
  loadGroupSnapshot(input: { companyId: string; groupId: string }): Promise<CompanyReportSnapshot>;
};

export type CompanyReportRefusalReason = {
  code: "insufficient_participants" | "insufficient_rows";
  actual: number;
  required: number;
};

export type CompanyReportAggregate = {
  kind?: AnonymizedActivityRecord["kind"];
  value?: AnonymizedActivityRecord["value"];
  durationBucket?: AnonymizedActivityRecord["durationBucket"];
  system?: AnonymizedActivityRecord["system"];
  date: string;
  rows: number;
};

export type CompanyReportRoleSlice = {
  status: "exported";
  roleId: string;
  participantCount: number;
  rowCount: number;
  aggregates: CompanyReportAggregate[];
} | {
  status: "refused";
  roleId: string;
  reasons: CompanyReportRefusalReason[];
};

export type CompanyReportResult = {
  status: "exported";
  companyId: string;
  groupId: string;
  participantCount: number;
  rowCount: number;
  roleSlices: CompanyReportRoleSlice[];
} | {
  status: "refused";
  companyId: string;
  groupId: string;
  reasons: CompanyReportRefusalReason[];
};

export const COMPANY_REPORT_OTHER_ROLE_ID = "other";

/** Company-facing read use-case. It never returns raw anonymized rows. */
export class CompanyReportingService {
  constructor(private readonly store: CompanyReportStore) {}

  async exportGroup(input: { companyId: string; groupId: string }): Promise<CompanyReportResult> {
    const companyId = input.companyId.trim();
    const groupId = input.groupId.trim();
    if (!companyId) throw new Error("companyId is required");
    if (!groupId) throw new Error("groupId is required");

    const snapshot = await this.store.loadGroupSnapshot({ companyId, groupId });
    const activities = snapshot.anonymizedActivities.filter(
      (activity) => activity.companyId === companyId && activity.groupId === groupId,
    );
    const groupReasons = thresholdFailures(snapshot.participantCounts.group, activities.length);
    if (groupReasons.length > 0) {
      return { status: "refused", companyId, groupId, reasons: groupReasons };
    }

    const activitiesByRole = groupActivitiesByRole(activities);
    const exportedRoles: CompanyReportRoleSlice[] = [];
    const rareRoleIds = new Set(
      [...snapshot.participantCounts.byRole.entries()]
        .filter(([, count]) => count < COMPANY_REPORT_MIN_PARTICIPANTS)
        .map(([roleId]) => roleId),
    );
    const otherActivities: AnonymizedActivityRecord[] = [];
    const otherParticipantCount = [...rareRoleIds].reduce(
      (total, roleId) => total + (snapshot.participantCounts.byRole.get(roleId) ?? 0),
      0,
    );

    for (const [roleId, roleActivities] of [...activitiesByRole.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const participantCount = snapshot.participantCounts.byRole.get(roleId) ?? 0;
      if (rareRoleIds.has(roleId)) {
        otherActivities.push(...roleActivities);
        continue;
      }
      exportedRoles.push(buildRoleSlice(roleId, participantCount, roleActivities));
    }

    if (otherActivities.length > 0) {
      exportedRoles.push(buildRoleSlice(COMPANY_REPORT_OTHER_ROLE_ID, otherParticipantCount, otherActivities));
    }

    return {
      status: "exported",
      companyId,
      groupId,
      participantCount: snapshot.participantCounts.group,
      rowCount: activities.length,
      roleSlices: exportedRoles,
    };
  }
}

function groupActivitiesByRole(activities: AnonymizedActivityRecord[]): Map<string, AnonymizedActivityRecord[]> {
  const result = new Map<string, AnonymizedActivityRecord[]>();
  for (const activity of activities) {
    const roleActivities = result.get(activity.roleId);
    if (roleActivities) roleActivities.push(activity);
    else result.set(activity.roleId, [activity]);
  }
  return result;
}

function buildRoleSlice(
  roleId: string,
  participantCount: number,
  activities: AnonymizedActivityRecord[],
): CompanyReportRoleSlice {
  const reasons = thresholdFailures(participantCount, activities.length);
  if (reasons.length > 0) return { status: "refused", roleId, reasons };
  return {
    status: "exported",
    roleId,
    participantCount,
    rowCount: activities.length,
    aggregates: aggregateActivities(activities),
  };
}

function thresholdFailures(participantCount: number, rowCount: number): CompanyReportRefusalReason[] {
  const reasons: CompanyReportRefusalReason[] = [];
  if (participantCount < COMPANY_REPORT_MIN_PARTICIPANTS) {
    reasons.push({ code: "insufficient_participants", actual: participantCount, required: COMPANY_REPORT_MIN_PARTICIPANTS });
  }
  if (rowCount < COMPANY_REPORT_MIN_ROWS) {
    reasons.push({ code: "insufficient_rows", actual: rowCount, required: COMPANY_REPORT_MIN_ROWS });
  }
  return reasons;
}

function aggregateActivities(activities: AnonymizedActivityRecord[]): CompanyReportAggregate[] {
  const aggregates = new Map<string, CompanyReportAggregate>();
  for (const activity of activities) {
    const dimensions = {
      ...(activity.kind === undefined ? {} : { kind: activity.kind }),
      ...(activity.value === undefined ? {} : { value: activity.value }),
      ...(activity.durationBucket === undefined ? {} : { durationBucket: activity.durationBucket }),
      ...(activity.system === undefined ? {} : { system: activity.system }),
      date: activity.date,
    };
    const key = JSON.stringify(dimensions);
    const existing = aggregates.get(key);
    if (existing) existing.rows += 1;
    else aggregates.set(key, { ...dimensions, rows: 1 });
  }
  return [...aggregates.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
