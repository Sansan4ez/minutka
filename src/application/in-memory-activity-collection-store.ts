import type {
  ActivityCollectionStore,
  AnonymizedActivityRecord,
  PersonalActivityRecord,
} from "./activity-collection.js";

export type InMemoryActivityCollectionState = {
  personalActivities: PersonalActivityRecord[];
  anonymizedActivities: AnonymizedActivityRecord[];
};

export function createInMemoryActivityCollectionState(): InMemoryActivityCollectionState {
  return { personalActivities: [], anonymizedActivities: [] };
}

export function createInMemoryActivityCollectionStore(
  state: InMemoryActivityCollectionState,
  options: { failAnonymizedWrite?: () => boolean } = {},
): ActivityCollectionStore {
  return {
    async saveActivityPair(input) {
      // Stage before publishing either side so failure cannot expose a partial pair.
      const personal = structuredClone(input.personal);
      const anonymized = structuredClone(input.anonymized);
      if (options.failAnonymizedWrite?.()) throw new Error("anonymized activity write failed");
      state.personalActivities.push(personal);
      state.anonymizedActivities.push(anonymized);
    },
  };
}
