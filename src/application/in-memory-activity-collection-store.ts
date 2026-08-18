import type { ActivityCollectionStore, PersonalActivityRecord } from "./activity-collection.js";
import { createTenantSubjectScopeIndex, type TenantSubjectScopeIndex } from "./tenant-subject-scope.js";

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
