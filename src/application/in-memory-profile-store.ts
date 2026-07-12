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
    async issueInvite({ employeeId, inviteCode, issuedAt }) {
      const existingByInvite = world.participants.find(
        (candidate) => candidate.inviteCode === inviteCode,
      );
      if (existingByInvite) return { participant: existingByInvite, created: false, inviteMatches: true };
      const existingByEmployee = world.participants.find(
        (candidate) => candidate.employeeId === employeeId,
      );
      if (existingByEmployee) return { participant: existingByEmployee, created: false, inviteMatches: false };
      const participant: Participant = {
        employeeId,
        inviteCode,
        status: "invite_issued",
        createdAt: issuedAt,
        updatedAt: issuedAt,
      };
      world.participants.push(participant);
      return { participant, created: true, inviteMatches: true };
    },
    async openInvite({ inviteCode, openedAt, explanationShownAt }) {
      const index = world.participants.findIndex((participant) => participant.inviteCode === inviteCode);
      if (index === -1) return undefined;
      const participant = world.participants[index];
      if (participant.status !== "invite_issued") return { participant, opened: false };
      const opened = {
        ...participant,
        status: "invite_opened" as const,
        updatedAt: openedAt,
        ...(explanationShownAt ? { privacyExplanationShownAt: explanationShownAt } : {}),
      };
      world.participants[index] = opened;
      return { participant: opened, opened: true };
    },
    async acceptConsent(consent) {
      const existing = world.consents.find((candidate) => candidate.employeeId === consent.employeeId);
      if (existing) return { consent: existing, created: false };
      world.consents.push(consent);
      const participant = world.participants.find((candidate) => candidate.employeeId === consent.employeeId);
      if (participant && participant.status !== "profile_completed") {
        upsertByEmployeeId(world.participants, {
          ...participant,
          status: "consent_accepted",
          updatedAt: consent.acceptedAt,
          privacyExplanationShownAt: participant.privacyExplanationShownAt,
        });
      }
      return { consent, created: true };
    },
    async recordPrivacyExplanationShown({ employeeId, shownAt }) {
      const participant = world.participants.find((candidate) => candidate.employeeId === employeeId);
      if (!participant) throw new Error("participant not found");
      upsertByEmployeeId(world.participants, {
        ...participant,
        privacyExplanationShownAt: shownAt,
        updatedAt: shownAt,
      });
    },
    async completeProfile({ profile, completedAt }) {
      const existing = world.profiles.find((candidate) => candidate.employeeId === profile.employeeId);
      upsertByEmployeeId(world.profiles, profile);
      const participant = world.participants.find((candidate) => candidate.employeeId === profile.employeeId);
      if (!participant) throw new Error("participant not found");
      const wasCompleted = participant.status === "profile_completed";
      upsertByEmployeeId(world.participants, {
        ...participant,
        status: "profile_completed",
        updatedAt: completedAt,
      });
      return { profile, wasCompleted: Boolean(existing && wasCompleted) };
    },
    async getParticipant(employeeId) {
      return world.participants.find((participant) => participant.employeeId === employeeId);
    },
    async getConsent(employeeId) {
      return world.consents.find((consent) => consent.employeeId === employeeId);
    },
    async getProfile(employeeId) {
      return world.profiles.find((profile) => profile.employeeId === employeeId);
    },
    async deleteEmployeePersonalData(employeeId) {
      for (const key of ["messages", "insights", "feedback", "profiles", "consents", "participants"] as const) {
        world[key] = world[key].filter((record) => record.employeeId !== employeeId) as never;
      }
      world.auditEvents = world.auditEvents.filter((record) => record.employeeId !== employeeId);
    },
  };
}
