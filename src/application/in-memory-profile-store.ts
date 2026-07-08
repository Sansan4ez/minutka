import type { Consent, Participant, UserProfile } from "../domain/employee.js";
import type { InMemoryWorld } from "./in-memory-world.js";
import type { ProfileStore } from "./profile-store.js";

function upsertByEmployeeId<T extends { employeeId: string }>(items: T[], value: T) {
  const index = items.findIndex((item) => item.employeeId === value.employeeId);
  if (index === -1) items.push(value);
  else items[index] = value;
}

export function createInMemoryProfileStore(world: InMemoryWorld): ProfileStore {
  return {
    async saveParticipant(participant: Participant) {
      upsertByEmployeeId(world.participants, participant);
    },

    async getParticipant(employeeId: string) {
      return world.participants.find((p) => p.employeeId === employeeId);
    },

    async getParticipantByInvite(inviteCode: string) {
      return world.participants.find((p) => p.inviteCode === inviteCode);
    },

    async saveConsent(consent: Consent) {
      upsertByEmployeeId(world.consents, consent);
    },

    async getConsent(employeeId: string) {
      return world.consents.find((c) => c.employeeId === employeeId);
    },

    async saveProfile(profile: UserProfile) {
      upsertByEmployeeId(world.profiles, profile);
    },

    async getProfile(employeeId: string) {
      return world.profiles.find((p) => p.employeeId === employeeId);
    },
  };
}
