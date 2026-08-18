import type { ActivityCollectionStore, PersonalActivityRecord } from "./activity-collection.js";

export type InMemoryActivityCollectionState = {
  activities: PersonalActivityRecord[];
};

export function createInMemoryActivityCollectionState(): InMemoryActivityCollectionState {
  return { activities: [] };
}

export function createInMemoryActivityCollectionStore(
  state: InMemoryActivityCollectionState,
  options: { failWrite?: () => boolean } = {},
): ActivityCollectionStore {
  return {
    async saveActivity(activity) {
      const canonical = structuredClone(activity);
      if (options.failWrite?.()) throw new Error("canonical activity write failed");
      state.activities.push(canonical);
    },
  };
}
