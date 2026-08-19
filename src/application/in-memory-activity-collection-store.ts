import type { ActivityCollectionStore, PersonalActivityRecord } from "./activity-collection.js";
import { createTenantSubjectScopeIndex, type TenantSubjectScopeIndex } from "./tenant-subject-scope.js";
import type { OwnActivityReadStore } from "./weekly-activity-summary.js";

export type InMemoryActivityCollectionState = {
  activities: PersonalActivityRecord[];
};

export function createInMemoryActivityCollectionState(): InMemoryActivityCollectionState {
  return { activities: [] };
}

export function createInMemoryActivityCollectionStore(
  state: InMemoryActivityCollectionState,
  options: { failWrite?: () => boolean; tenantScope?: TenantSubjectScopeIndex } = {},
): ActivityCollectionStore {
  const tenantScope = options.tenantScope ?? createTenantSubjectScopeIndex();
  return {
    async saveActivity(activity) {
      const canonical = structuredClone(activity);
      if (options.failWrite?.()) throw new Error("canonical activity write failed");
      tenantScope.bindSubject(canonical);
      tenantScope.bindOwner(canonical.employeeId, canonical);
      state.activities.push(canonical);
    },
  };
}

/** Owner-scoped read side of the same canonical activity state. */
export function createInMemoryOwnActivityReadStore(
  state: InMemoryActivityCollectionState,
): OwnActivityReadStore {
  return {
    async listOwnActivities({ employeeId, fromDate, toDate }) {
      return state.activities
        .filter((activity) => activity.employeeId === employeeId
          && activity.activityDate >= fromDate
          && activity.activityDate <= toDate)
        .map((activity) => ({
          employeeId: activity.employeeId,
          ...(activity.taskCategory === undefined ? {} : { taskCategory: activity.taskCategory }),
          ...(activity.obstacle === undefined ? {} : { obstacle: activity.obstacle }),
          ...(activity.durationBucket === undefined ? {} : { durationBucket: activity.durationBucket }),
          ...(activity.system === undefined ? {} : { system: activity.system }),
          activityDate: activity.activityDate,
        }));
    },
  };
}
