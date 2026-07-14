import type { InMemoryWorld } from "./in-memory-world.js";
import { PersistenceError } from "./persistence-error.js";
import type { OnboardingDraftStore } from "./onboarding-draft-store.js";
import type { OnboardingDraft } from "./onboarding-types.js";

export function createInMemoryOnboardingDraftStore(world: InMemoryWorld): OnboardingDraftStore {
  return {
    async get(employeeId) {
      const draft = world.onboardingDrafts.find((candidate) => candidate.employeeId === employeeId);
      if (!draft || new Date(draft.expiresAt).getTime() <= new Date(world.now()).getTime()) {
        if (draft) world.onboardingDrafts = world.onboardingDrafts.filter((candidate) => candidate.employeeId !== employeeId);
        return undefined;
      }
      return structuredClone(draft);
    },
    async save(draft, expectedRevision) {
      if (world.participants.some((participant) => participant.employeeId === draft.employeeId && participant.status === "profile_completed")) throw new PersistenceError("persistence_conflict");
      let index = world.onboardingDrafts.findIndex((candidate) => candidate.employeeId === draft.employeeId);
      let existing = index === -1 ? undefined : world.onboardingDrafts[index];
      if (existing && new Date(existing.expiresAt).getTime() <= new Date(world.now()).getTime()) {
        world.onboardingDrafts.splice(index, 1);
        index = -1;
        existing = undefined;
      }
      if (expectedRevision !== undefined && existing && existing.revision !== expectedRevision) throw new PersistenceError("persistence_conflict");
      if (expectedRevision !== undefined && !existing && expectedRevision !== 0) throw new PersistenceError("persistence_conflict");
      const saved = structuredClone(draft);
      if (index === -1) world.onboardingDrafts.push(saved);
      else world.onboardingDrafts[index] = saved;
      return structuredClone(saved);
    },
    async replace(draft) {
      if (world.participants.some((participant) => participant.employeeId === draft.employeeId && participant.status === "profile_completed")) throw new PersistenceError("persistence_conflict");
      const index = world.onboardingDrafts.findIndex((candidate) => candidate.employeeId === draft.employeeId);
      const saved = structuredClone(draft);
      if (index === -1) world.onboardingDrafts.push(saved);
      else world.onboardingDrafts[index] = saved;
      return structuredClone(saved);
    },
    async delete(employeeId) { world.onboardingDrafts = world.onboardingDrafts.filter((candidate) => candidate.employeeId !== employeeId); },
    async purgeExpired() {
      const now = new Date(world.now()).getTime();
      const before = world.onboardingDrafts.length;
      world.onboardingDrafts = world.onboardingDrafts.filter((candidate) => new Date(candidate.expiresAt).getTime() > now);
      return before - world.onboardingDrafts.length;
    },
  };
}
