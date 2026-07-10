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

    async claimParticipantByInvite(participant: Participant) {
      const existingByInvite = world.participants.find(
        (candidate) => candidate.inviteCode === participant.inviteCode,
      );
      if (existingByInvite) return { participant: existingByInvite, created: false };

      const existingByEmployee = world.participants.find(
        (candidate) => candidate.employeeId === participant.employeeId,
      );
      if (existingByEmployee) return { participant: existingByEmployee, created: false };

      world.participants.push(participant);
      return { participant, created: true };
    },

    async openParticipantByInvite(inviteCode: string, openedAt: string) {
      const index = world.participants.findIndex(
        (participant) => participant.inviteCode === inviteCode,
      );
      if (index === -1) return undefined;

      const participant = world.participants[index];
      if (participant.status !== "invite_issued") {
        return { participant, opened: false };
      }

      const opened = {
        ...participant,
        status: "invite_opened" as const,
        updatedAt: openedAt,
      };
      world.participants[index] = opened;
      return { participant: opened, opened: true };
    },

    async getParticipant(employeeId: string) {
      return world.participants.find((p) => p.employeeId === employeeId);
    },

    async getParticipantByInvite(inviteCode: string) {
      return world.participants.find((p) => p.inviteCode === inviteCode);
    },

    async claimConsent(consent: Consent) {
      const existing = world.consents.find(
        (candidate) => candidate.employeeId === consent.employeeId,
      );
      if (existing) return { consent: existing, created: false };

      world.consents.push(consent);
      return { consent, created: true };
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
