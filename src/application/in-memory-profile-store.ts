import type { Consent, Participant, UserProfile } from "../domain/employee.js";
import type { InMemoryWorld } from "./in-memory-world.js";
import type { ProfileStore } from "./profile-store.js";

function upsertByEmployeeId<T extends { employeeId: string }>(items: T[], value: T) {
  const index = items.findIndex((item) => item.employeeId === value.employeeId);
  if (index === -1) items.push(value);
  else items[index] = value;
}

const inviteIndexes = new WeakMap<InMemoryWorld, Map<string, string>>();

/**
 * Executable-spec store. Raw invite codes stay outside observable world state,
 * while adapters over the same fixture share the private lookup.
 */
export function createInMemoryProfileStore(world: InMemoryWorld): ProfileStore {
  const employeeByInviteCode = inviteIndexes.get(world) ?? new Map<string, string>();
  inviteIndexes.set(world, employeeByInviteCode);

  return {
    async issueInvite({ employeeId, inviteCode, issuedAt }) {
      const existingEmployeeForInvite = employeeByInviteCode.get(inviteCode);
      if (existingEmployeeForInvite) {
        const participant = world.participants.find((candidate) => candidate.employeeId === existingEmployeeForInvite);
        if (!participant) throw new Error("in-memory invite index is inconsistent");
        return {
          participant,
          created: false,
          inviteMatches: existingEmployeeForInvite === employeeId,
        };
      }
      const existingByEmployee = world.participants.find((candidate) => candidate.employeeId === employeeId);
      if (existingByEmployee) return { participant: existingByEmployee, created: false, inviteMatches: false };
      const participant: Participant = {
        employeeId,
        status: "invite_issued",
        createdAt: issuedAt,
        updatedAt: issuedAt,
      };
      employeeByInviteCode.set(inviteCode, employeeId);
      world.participants.push(participant);
      return { participant, created: true, inviteMatches: true };
    },
    async openInvite({ inviteCode, openedAt, explanationShownAt }) {
      const employeeId = employeeByInviteCode.get(inviteCode);
      if (!employeeId) return undefined;
      const index = world.participants.findIndex((participant) => participant.employeeId === employeeId);
      if (index === -1) throw new Error("in-memory invite index is inconsistent");
      const participant = world.participants[index];
      if (participant.status !== "invite_issued") return { participant, opened: false };
      const opened: Participant = {
        ...participant,
        status: "invite_opened",
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
      for (const [inviteCode, indexedEmployeeId] of employeeByInviteCode) {
        if (indexedEmployeeId === employeeId) employeeByInviteCode.delete(inviteCode);
      }
      world.auditEvents = world.auditEvents.filter((record) => record.employeeId !== employeeId);
    },
  };
}
